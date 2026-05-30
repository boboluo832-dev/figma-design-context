import { describe, it, expect } from "vitest";
import { diffNodes, formatDiffOutput } from "../src/diff.js";

describe("diffNodes", () => {
  it("returns empty array for identical trees", () => {
    const node = {
      id: "1:1",
      name: "Frame",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { id: "1:2", name: "Text", type: "TEXT", characters: "Hello" },
      ],
    };
    const result = diffNodes(node, node);
    expect(result).toEqual([]);
  });

  it("detects property changes on root node", () => {
    const a = { id: "1:1", name: "Frame", type: "FRAME", opacity: 1 };
    const b = { id: "1:1", name: "Frame", type: "FRAME", opacity: 0.5 };
    const result = diffNodes(a, b);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("changed");
    expect(result[0].changes).toContainEqual({ prop: "opacity", from: "1", to: "0.5" });
  });

  it("detects size changes via absoluteBoundingBox", () => {
    const a = { id: "1:1", name: "Box", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 } };
    const b = { id: "1:1", name: "Box", type: "FRAME", absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 50 } };
    const result = diffNodes(a, b);
    expect(result.length).toBe(1);
    expect(result[0].changes).toContainEqual({ prop: "size", from: "100×50", to: "200×50" });
  });

  it("detects position changes", () => {
    const a = { id: "1:1", name: "Box", type: "FRAME", absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 100 } };
    const b = { id: "1:1", name: "Box", type: "FRAME", absoluteBoundingBox: { x: 30, y: 40, width: 100, height: 100 } };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual({ prop: "position", from: "(10, 20)", to: "(30, 40)" });
  });

  it("detects text content changes", () => {
    const a = { id: "1:1", name: "Label", type: "TEXT", characters: "Hello" };
    const b = { id: "1:1", name: "Label", type: "TEXT", characters: "World" };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual({ prop: "content", from: "Hello", to: "World" });
  });

  it("detects text style changes", () => {
    const a = { id: "1:1", name: "Label", type: "TEXT", characters: "Hi", style: { fontSize: 14, fontFamily: "Inter" } };
    const b = { id: "1:1", name: "Label", type: "TEXT", characters: "Hi", style: { fontSize: 16, fontFamily: "Inter" } };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual({ prop: "fontSize", from: "14", to: "16" });
  });

  it("detects added children", () => {
    const a = {
      id: "1:1", name: "Parent", type: "FRAME",
      children: [{ id: "1:2", name: "Child1", type: "TEXT" }],
    };
    const b = {
      id: "1:1", name: "Parent", type: "FRAME",
      children: [
        { id: "1:2", name: "Child1", type: "TEXT" },
        { id: "1:3", name: "Child2", type: "FRAME" },
      ],
    };
    const result = diffNodes(a, b);
    const added = result.find((r) => r.type === "added");
    expect(added).toBeDefined();
    expect(added!.nodeName).toBe("Child2");
    expect(added!.nodeId).toBe("1:3");
  });

  it("detects removed children", () => {
    const a = {
      id: "1:1", name: "Parent", type: "FRAME",
      children: [
        { id: "1:2", name: "Child1", type: "TEXT" },
        { id: "1:3", name: "Child2", type: "FRAME" },
      ],
    };
    const b = {
      id: "1:1", name: "Parent", type: "FRAME",
      children: [{ id: "1:2", name: "Child1", type: "TEXT" }],
    };
    const result = diffNodes(a, b);
    const removed = result.find((r) => r.type === "removed");
    expect(removed).toBeDefined();
    expect(removed!.nodeName).toBe("Child2");
  });

  it("respects depth limit", () => {
    const deepChild = { id: "1:4", name: "Deep", type: "TEXT", characters: "A" };
    const a = {
      id: "1:1", name: "Root", type: "FRAME",
      children: [{
        id: "1:2", name: "Mid", type: "FRAME",
        children: [{
          id: "1:3", name: "Inner", type: "FRAME",
          children: [deepChild],
        }],
      }],
    };
    const b = {
      id: "1:1", name: "Root", type: "FRAME",
      children: [{
        id: "1:2", name: "Mid", type: "FRAME",
        children: [{
          id: "1:3", name: "Inner", type: "FRAME",
          children: [{ ...deepChild, characters: "B" }],
        }],
      }],
    };
    const shallow = diffNodes(a, b, 2);
    const hasDeepChange = shallow.some((r) => r.type === "changed" && r.changes?.some((c) => c.prop === "content"));
    expect(hasDeepChange).toBe(false);

    const deep = diffNodes(a, b, 5);
    const hasDeepChangeNow = deep.some((r) => r.type === "changed" && r.changes?.some((c) => c.prop === "content"));
    expect(hasDeepChangeNow).toBe(true);
  });

  it("handles null/undefined nodes gracefully", () => {
    const result = diffNodes(null, null);
    expect(result).toEqual([]);
  });

  it("detects fill changes", () => {
    const a = {
      id: "1:1", name: "Box", type: "FRAME",
      fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 } }],
    };
    const b = {
      id: "1:1", name: "Box", type: "FRAME",
      fills: [{ type: "SOLID", visible: true, color: { r: 0, g: 0, b: 1 } }],
    };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual(
      expect.objectContaining({ prop: "fills" })
    );
  });

  it("detects layout mode changes", () => {
    const a = { id: "1:1", name: "Box", type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 8 };
    const b = { id: "1:1", name: "Box", type: "FRAME", layoutMode: "VERTICAL", itemSpacing: 16 };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual({ prop: "layoutMode", from: "HORIZONTAL", to: "VERTICAL" });
    expect(result[0].changes).toContainEqual({ prop: "itemSpacing", from: "8", to: "16" });
  });

  it("detects cornerRadius changes", () => {
    const a = { id: "1:1", name: "Box", type: "FRAME", cornerRadius: 4 };
    const b = { id: "1:1", name: "Box", type: "FRAME", cornerRadius: 12 };
    const result = diffNodes(a, b);
    expect(result[0].changes).toContainEqual({ prop: "cornerRadius", from: "4", to: "12" });
  });
});

describe("formatDiffOutput", () => {
  it("returns no-diff message for empty entries", () => {
    expect(formatDiffOutput([])).toBe("无差异，两个节点完全相同");
  });

  it("formats changed entries with property details", () => {
    const output = formatDiffOutput([{
      type: "changed",
      path: "Root > Button",
      nodeType: "FRAME",
      nodeName: "Button",
      nodeId: "1:2",
      changes: [{ prop: "opacity", from: "1", to: "0.5" }],
    }]);
    expect(output).toContain("[CHANGED]");
    expect(output).toContain("Button");
    expect(output).toContain("opacity");
    expect(output).toContain("1 → 0.5");
  });

  it("formats added entries", () => {
    const output = formatDiffOutput([{
      type: "added",
      path: "Root",
      nodeType: "TEXT",
      nodeName: "NewLabel",
      nodeId: "1:5",
    }]);
    expect(output).toContain("[ADDED]");
    expect(output).toContain("NewLabel");
  });

  it("formats removed entries", () => {
    const output = formatDiffOutput([{
      type: "removed",
      path: "Root",
      nodeType: "FRAME",
      nodeName: "OldBox",
      nodeId: "1:3",
    }]);
    expect(output).toContain("[REMOVED]");
    expect(output).toContain("OldBox");
  });

  it("formats unchanged entries with children count", () => {
    const output = formatDiffOutput([{
      type: "unchanged",
      path: "Root > Container",
      nodeType: "",
      nodeName: "",
      childrenCount: 5,
    }]);
    expect(output).toContain("[UNCHANGED]");
    expect(output).toContain("5 children");
  });
});
