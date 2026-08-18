import { describe, expect, it } from "vitest";
import {
  agentFloatingDragMoved,
  agentFloatingSnapEdge,
  clampAgentFloatingPosition,
  nearestAgentFloatingEdge,
  snapAgentFloatingPosition,
  type AgentFloatingViewport,
} from "../src/client/agent-floating-position";

const viewport: AgentFloatingViewport = { width: 1200, height: 800 };

describe("AI Agent floating button position", () => {
  it("keeps the expanded button inside the viewport margin", () => {
    expect(clampAgentFloatingPosition({ x: -100, y: 900 }, viewport)).toEqual({ x: 16, y: 720 });
  });

  it("selects the closest of all four viewport edges", () => {
    expect(nearestAgentFloatingEdge({ x: 20, y: 300 }, viewport).edge).toBe("left");
    expect(nearestAgentFloatingEdge({ x: 1100, y: 300 }, viewport).edge).toBe("right");
    expect(nearestAgentFloatingEdge({ x: 500, y: 18 }, viewport).edge).toBe("top");
    expect(nearestAgentFloatingEdge({ x: 500, y: 710 }, viewport).edge).toBe("bottom");
  });

  it("only auto-collapses when released within the snap threshold", () => {
    expect(agentFloatingSnapEdge({ x: 60, y: 300 }, viewport)).toBe("left");
    expect(agentFloatingSnapEdge({ x: 240, y: 260 }, viewport)).toBeNull();
  });

  it("snaps to an edge without changing the perpendicular coordinate", () => {
    expect(snapAgentFloatingPosition({ x: 220, y: 310 }, "right", viewport)).toEqual({ x: 1120, y: 310 });
    expect(snapAgentFloatingPosition({ x: 220, y: 310 }, "bottom", viewport)).toEqual({ x: 220, y: 720 });
  });

  it("keeps small pointer movement as a click instead of a drag", () => {
    expect(agentFloatingDragMoved({ x: 100, y: 100 }, { x: 106, y: 104 })).toBe(false);
    expect(agentFloatingDragMoved({ x: 100, y: 100 }, { x: 108, y: 100 })).toBe(true);
  });
});
