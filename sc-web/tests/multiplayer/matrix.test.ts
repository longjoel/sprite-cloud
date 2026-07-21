import { describe, expect, it } from "vitest";
import { getMultiplayerVerificationMatrix } from "@/lib/multiplayer-verification-matrix";

describe("multiplayer verification matrix", () => {
  it("covers all four intended connectivity scenarios with explicit evidence requirements", () => {
    const matrix = getMultiplayerVerificationMatrix();

    expect(matrix).toHaveLength(4);
    expect(matrix.map((scenario) => scenario.id)).toEqual([
      "same-machine-two-browsers",
      "remote-friendly-nat",
      "same-lan-as-sc-server",
      "cross-network-hostile-nat-or-cellular",
    ]);

    for (const scenario of matrix) {
      expect(scenario.title.length).toBeGreaterThan(10);
      expect(scenario.passEvidence.connectionSuccess).toBeTruthy();
      expect(scenario.passEvidence.transportRoute).toBeTruthy();
      expect(scenario.passEvidence.connectTime).toBeTruthy();
      expect(scenario.passEvidence.mediaAndDataChannel).toBeTruthy();
      expect(scenario.logGuidance.browser.length).toBeGreaterThan(0);
      expect(scenario.logGuidance.scWeb.length).toBeGreaterThan(0);
      expect(scenario.logGuidance.scServer.length).toBeGreaterThan(0);
      expect(scenario.logGuidance.coturn.length).toBeGreaterThan(0);
      expect(scenario.automation.length + scenario.manualProcedure.length).toBeGreaterThan(0);
    }
  });

  it("marks only same-machine as fully automatable with the current harness", () => {
    const matrix = getMultiplayerVerificationMatrix();
    const automated = matrix.filter((scenario) => scenario.automation.length > 0).map((scenario) => scenario.id);

    expect(automated).toContain("same-machine-two-browsers");
    expect(automated).not.toContain("remote-friendly-nat");
    expect(automated).not.toContain("same-lan-as-sc-server");
    expect(automated).not.toContain("cross-network-hostile-nat-or-cellular");
  });
});
