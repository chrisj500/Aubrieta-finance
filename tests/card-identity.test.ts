import { describe, expect, it } from "vitest";
import { createTestDb, seedManualAccount, seedUser } from "./helpers";
import {
  createInstitutionNormalizer,
  listCardProducts,
  resolveCardIdentities,
  setCardIdentityOverride,
  setInstitutionAlias,
} from "@/server/domain/account-identity";

describe("account identity normalization", () => {
  it("normalizes common institution aliases and lets a user override an alias", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "institution-normalize");
    let normalize = await createInstitutionNormalizer(db, user.id);
    expect(normalize("JPMorgan Chase Bank, N.A.")).toBe("Chase Bank");
    expect(normalize("American Express National Bank")).toBe("American Express");

    await setInstitutionAlias(db, user.id, "My Chase Login", "Chase Bank");
    normalize = await createInstitutionNormalizer(db, user.id);
    expect(normalize("My Chase Login")).toBe("Chase Bank");
  });

  it("resolves exact, likely, generic, and user-overridden card identities", async () => {
    const db = createTestDb();
    const user = await seedUser(db, "card-identity");
    const exactId = await seedManualAccount(db, user.id, "Chase Sapphire Preferred (7781)", "credit");
    const likelyId = await seedManualAccount(db, user.id, "C. JACKSON (0769)", "credit");
    const genericId = await seedManualAccount(db, user.id, "MYSTERY CARD 1234", "credit");

    const inputs = [
      { id: exactId, name: "Chase Sapphire Preferred (7781)", institution_name: "Chase Bank", type: "credit" },
      { id: likelyId, name: "C. JACKSON (0769)", institution_name: "Chase Bank", type: "credit" },
      { id: genericId, name: "MYSTERY CARD 1234", institution_name: "Community CU", type: "credit" },
    ];
    let identities = await resolveCardIdentities(db, user.id, inputs);
    expect(identities.get(exactId)).toMatchObject({ product: "Sapphire Preferred", confidence: "exact", source: "predicted", primary: "#123D67" });
    expect(identities.get(likelyId)).toMatchObject({ issuer: "Chase", product: "Card", confidence: "likely" });
    expect(identities.get(genericId)).toMatchObject({ confidence: "generic" });

    const products = await listCardProducts(db);
    expect(products.some((product) => product.key === "amex_business_gold")).toBe(true);
    await setCardIdentityOverride(db, user.id, genericId, { productKey: "amex_business_gold" });
    identities = await resolveCardIdentities(db, user.id, inputs);
    expect(identities.get(genericId)).toMatchObject({ product: "Business Gold", confidence: "exact", source: "override", primary: "#A67C2E" });
  });
});
