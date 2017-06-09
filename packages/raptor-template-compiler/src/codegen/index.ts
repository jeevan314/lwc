import generate from 'babel-generator';
import * as t from 'babel-types';

import template = require('babel-template');

import {
    TEMPLATE_PARAMS,
} from './constants';

import {
    applyExpressionBinding,
} from './scope';

import {
    RENDER_PRIMITIVE_API,
    createText,
    createElement,
    createCustomElement,
    identifierFromComponentName,
    importFromComponentName,
    objectToAST,
} from './helpers';

import {
    createElement as createIRElement,
    traverse,
    isElement,
    isCustomElement,
} from '../shared/ir';

import {
    IRNode,
    IRElement,
    IRText,
    CompilationMetadata,
    CompilationOutput,
    TemplateExpression,
} from '../shared/types';

import * as memorization from './memorization';

import Stack from '../shared/stack';

function applyInlineIf(element: IRElement, babelNode: t.Expression) {
    if (!element.if) {
        return babelNode;
    }

    const modifier = element.ifModifier!;
    const boundTestExpression = applyExpressionBinding(element.if!, element);

    let leftExpression: t.Expression;
    if (modifier === 'true') {
        leftExpression = boundTestExpression;
    } else if (modifier === 'false') {
        leftExpression = t.unaryExpression('!', boundTestExpression);
    } else if (modifier === 'strict-true') {
        leftExpression = t.binaryExpression('===', boundTestExpression, t.booleanLiteral(true));
    } else {
        throw new Error(`Unknown if modifier ${modifier}`);
    }

    return t.conditionalExpression(
        leftExpression,
        babelNode,
        t.nullLiteral(),
    );
}

function applyInlineFor(element: IRElement, babelNode: t.Expression) {
    if (!element.for) {
        return babelNode;
    }

    const iterationFunction = t.functionExpression(
        undefined,
        [element.forItem!, element.forIterator!],
        t.blockStatement([
            t.returnStatement(babelNode),
        ]),
    );
    const iterable = applyExpressionBinding(element.for!, element);

    return t.callExpression(
        RENDER_PRIMITIVE_API.ITERATOR,
        [ iterable, iterationFunction ],
    );
}

function applyTemplateIf(element: IRElement, fragmentNodes: t.Expression): t.Expression {
    if (!element.if) {
        return fragmentNodes;
    }

    if (t.isArrayExpression(fragmentNodes)) {
        return t.arrayExpression(
            fragmentNodes.elements.map((child: t.Expression) => (
                applyInlineIf(element, child)
            )),
        );
    } else {
        return applyInlineIf(element, fragmentNodes);
    }
}

function applyTemplateFor(element: IRElement, fragmentNodes: t.Expression): t.Expression {
    if (!element.for) {
        return fragmentNodes;
    }

    let expression = fragmentNodes;
    if (t.isArrayExpression(expression) && expression.elements.length === 1) {
        expression = expression.elements[0] as t.Expression;
    }

    return applyInlineFor(element, expression);
}

function computeAttrValue(attrValue: TemplateExpression | string, element: IRElement): t.Expression {
    if (typeof attrValue === 'string') {
        if (attrValue.length) {
            return t.stringLiteral(attrValue);
        } else {
            return t.booleanLiteral(true);
        }
    } else {
        return applyExpressionBinding(attrValue, element);
    }
}

function elementDataBag(element: IRElement): t.ObjectExpression {
    const { classMap, className, style, attrs, props, on, forKey } = element;
    const data: t.ObjectProperty[] = [];

    if (className) {
        data.push(
            t.objectProperty(t.identifier('className'), applyExpressionBinding(className, element)),
        );
    }

    if (classMap) {
        const classMapObj = objectToAST(classMap, () => t.booleanLiteral(true));
        data.push(t.objectProperty(t.identifier('classMap'), classMapObj));
    }

    if (style) {
        const styleObj = objectToAST(style, (key) => (
            typeof style[key] === 'number' ?
                t.numericLiteral(style[key] as number) :
                t.stringLiteral(style[key] as string)
        ));
        data.push(t.objectProperty(t.identifier('style'), styleObj));
    }

    if (attrs) {
        const atrsObj = objectToAST(attrs, (key) => computeAttrValue(attrs[key], element));
        data.push(t.objectProperty(t.identifier('attrs'), atrsObj));
    }

    if (props) {
        const propsObj = objectToAST(props, (key) => computeAttrValue(props[key], element));
        data.push(t.objectProperty(t.identifier('props'), propsObj));
    }

    if (forKey) {
        data.push(t.objectProperty(t.identifier('key'), forKey));
    }

    if (on) {
        const onObj = objectToAST(on, (key) => {
            const handler = applyExpressionBinding(on[key], element);
            return memorization.memorize(handler);
        });
        data.push(t.objectProperty(t.identifier('on'), onObj));
    }

    return t.objectExpression(data);
}

function shouldFlatten(element: IRElement): boolean {
    return element.children.some((child) => (
        isElement(child) && (
            (isSlot(child) || !!child.for) ||
            isTemplate(child) && shouldFlatten(child)
        )
    ));
}

const TEMPLATE_FUNCTION = template(
    `export default function tmpl(API, CMP, SLOT_SET, CONTEXT) {
        return STATEMENT;
    }`,
    { sourceType: 'module' },
);

const isTemplate = (element: IRElement) => element.tag === 'template';
const isSlot = (element: IRElement) => element.tag === 'slot';

export function transform(
    root: IRNode,
): t.Expression {
    const stack = new Stack< t.Expression >();
    stack.push(
        t.arrayExpression([]),
    );

    traverse(root, {
        text: {
            exit(textNode: IRText) {
                let { value }  = textNode;
                if (typeof value !== 'string') {
                    value = applyExpressionBinding(value, textNode);
                }

                const babelTextNode = createText(value);
                (stack.peek() as t.ArrayExpression).elements.push(babelTextNode);
            },
        },

        element: {
            enter() {
                const childrenEpression = t.arrayExpression([]);
                stack.push(childrenEpression);
            },

            exit(element: IRElement) {
                let children = stack.pop();

                if (shouldFlatten(element)) {
                    if (t.isArrayExpression(children)) {
                        children = element.children.length === 1 ?
                            children.elements[0] as t.Expression :
                            t.callExpression(RENDER_PRIMITIVE_API.FLATTENING, [children]);
                    }
                }

                // if (t.isArrayExpression(children)) {
                //     const elements: t.Expression[] = children.elements.reduce((acc: t.Expression[], child) => (
                //         t.isArrayExpression(child) ? acc.concat(child.elements as t.Expression) : acc.concat(child)
                //     ), []);
                //     children.elements = elements;
                // }

                if (isTemplate(element)) {
                    transformTemplate(element, children);
                } else {
                    transformElement(element, children);
                }
            },
        },
    });

    function transformElement(element: IRElement, children: t.Expression) {
        const databag = elementDataBag(element);

        let babelElement: t.Expression;
        if (isCustomElement(element)) {
            // Traverse custom components slots and it to the databag
            transformSlotset(element, databag);

            // Make sure to register the component
            const componentClassName = element.component!;

            babelElement = createCustomElement(
                element.tag,
                identifierFromComponentName(componentClassName),
                databag,
            );
        } else if (isSlot(element)) {
            babelElement = t.logicalExpression(
                '||',
                t.memberExpression(t.identifier(TEMPLATE_PARAMS.SLOT_SET), t.identifier(element.slotName)),
                children,
            );
        } else {
            babelElement = createElement(
                element.tag,
                databag,
                children,
            );
        }

        babelElement = applyInlineIf(element, babelElement);
        babelElement = applyInlineFor(element, babelElement);

        (stack.peek() as t.ArrayExpression).elements.push(babelElement);
    }

    function transformTemplate(element: IRElement, children: t.Expression) {
        let expression = applyTemplateIf(element, children);

        if (element.for) {
            expression = applyTemplateFor(element, expression);
            (stack.peek() as t.ArrayExpression).elements.push(expression);
        } else if (t.isArrayExpression(expression) && element.if) {
            // Inject inlined if elements directly
            return (stack.peek() as t.ArrayExpression).elements.push(...expression.elements);
        } else {
            (stack.peek() as t.ArrayExpression).elements.push(expression);
        }
    }

    function transformSlotset(element: IRElement, databag: t.ObjectExpression) {
        if (!element.slotSet) {
            return;
        }

        const slots: t.ObjectProperty[] = [];
        Object.keys(element.slotSet).forEach((key) => {

            const slotRoot = createIRElement('template', {});
            slotRoot.children = element.slotSet![key];
            slots.push(
                t.objectProperty(
                    t.stringLiteral(key),
                    transform(slotRoot),
                ),
            );
        });

        databag.properties.push(
            t.objectProperty(t.stringLiteral('slotset'), t.objectExpression(slots)),
        );
    }

    return (stack.peek() as t.ArrayExpression).elements[0] as t.Expression;
}

export default function(templateRoot: IRElement, metadata: CompilationMetadata): CompilationOutput {
    memorization.reset();

    const statement = transform(templateRoot);

    const content = TEMPLATE_FUNCTION({
        API: t.identifier(TEMPLATE_PARAMS.API),
        CMP: t.identifier(TEMPLATE_PARAMS.INSTANCE),
        SLOT_SET: t.identifier(TEMPLATE_PARAMS.SLOT_SET),
        CONTEXT: t.identifier(TEMPLATE_PARAMS.CONTEXT),
        STATEMENT:  statement,
    }) as t.Statement;

    const imports = metadata.templateDependencies.map((cmpClassName) => (
        importFromComponentName(cmpClassName)
    ));

    const program = t.program([
        ...imports,
        content,
    ]);

    const { code } = generate(program);
    return {
        ast: program,
        code,
    };
}