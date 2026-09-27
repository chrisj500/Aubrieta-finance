import { describe, expect, it } from "vitest";
import { predictCardIdentity } from "@/lib/card-identity";

describe("predicted credit-card identity", () => {
  it("recognizes common Chase and Amex products with fixed brand palettes", () => {
    const sapphire = predictCardIdentity({ name: "Chase Sapphire Preferred (7781)", institutionName: "Chase Bank" });
    expect(sapphire.product).toBe("Sapphire Preferred");
    expect(sapphire.primary).toBe("#123D67");
    expect(sapphire.confidence).toBe("high");

    const gold = predictCardIdentity({ name: "Business Gold Card (2004)", institutionName: "American Express" });
    expect(gold.product).toBe("Gold");
    expect(gold.primary).toBe("#A67C2E");
    expect(gold.network).toBe("AMEX");

    const blue = predictCardIdentity({ name: "Blue Business Plus (3000)", institutionName: "American Express" });
    expect(blue.product).toBe("Blue Business Plus");
    expect(blue.primary).toBe("#006FCF");
  });

  it("uses issuer-aware fallback colors without depending on app theme tokens", () => {
    const chase = predictCardIdentity({ name: "C. JACKSON (0769)", institutionName: "Chase Bank" });
    expect(chase.confidence).toBe("medium");
    expect(chase.primary).toMatch(/^#[0-9A-F]{6}$/i);
    expect(chase.primary).not.toContain("var(");
  });
});
