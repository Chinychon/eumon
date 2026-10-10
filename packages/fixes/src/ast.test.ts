import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasDirective, lineIndent, parseModule, unwrap, walk, type AstNode } from "./ast.js";

describe("ast helpers", () => {
  it("parses TSX and walks every node", () => {
    const program = parseModule(`import a from "a";\nexport default function Page() { return <main><h1>Hi</h1></main>; }`);
    const types: string[] = [];
    walk(program, (node) => { types.push(node.type); });
    assert.ok(types.includes("JSXElement"));
    assert.ok(types.includes("ImportDeclaration"));
  });

  it("skips a subtree when the visitor says so", () => {
    const program = parseModule(`function a() { function b() { return 1; } return 2; }`);
    const returns: number[] = [];
    walk(program, (node) => {
      if (node.type === "FunctionDeclaration" && (node.id as AstNode).name === "b") return "skip";
      if (node.type === "ReturnStatement") returns.push(node.start);
    });
    assert.equal(returns.length, 1);
  });

  it("unwraps satisfies/as and reads indentation and directives", () => {
    const source = `"use client";\nexport const metadata = { title: "x" } satisfies Metadata;`;
    const program = parseModule(source);
    assert.equal(hasDirective(program, "use client"), true);
    let init: AstNode | undefined;
    walk(program, (node) => { if (node.type === "VariableDeclarator") init = node.init as AstNode; });
    assert.equal(unwrap(init!).type, "ObjectExpression");
    assert.equal(lineIndent("a\n    b", 6), "    ");
  });
});
