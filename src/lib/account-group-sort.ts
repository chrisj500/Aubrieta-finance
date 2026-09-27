export type AccountGroupSort = "name" | "balance" | "due";
export type AccountGroupSortDir = "asc" | "desc";

export interface GroupSortableAccount {
  name: string;
  current_balance_cents: number | null;
  balance_with_pending_cents?: number;
  next_payment_due_date?: string | null;
}

export interface InstitutionAccountGroup<T extends GroupSortableAccount = GroupSortableAccount> {
  name: string;
  accounts: T[];
}

export function sortInstitutionGroups<T extends GroupSortableAccount>(
  groups: InstitutionAccountGroup<T>[],
  sortBy: AccountGroupSort,
  sortDir: AccountGroupSortDir,
  includePending: boolean,
): InstitutionAccountGroup<T>[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...groups].sort((a, b) => {
    if (sortBy === "balance") {
      const total = (accounts: T[]) => accounts.reduce((sum, account) =>
        sum + Math.abs(includePending
          ? (account.balance_with_pending_cents ?? account.current_balance_cents ?? 0)
          : (account.current_balance_cents ?? 0)), 0);
      return (total(a.accounts) - total(b.accounts)) * direction || a.name.localeCompare(b.name);
    }
    if (sortBy === "due") {
      const earliest = (accounts: T[]) => accounts
        .map((account) => account.next_payment_due_date)
        .filter((date): date is string => Boolean(date))
        .sort()[0] ?? null;
      const ad = earliest(a.accounts);
      const bd = earliest(b.accounts);
      if (!ad && !bd) return a.name.localeCompare(b.name);
      if (!ad) return 1;
      if (!bd) return -1;
      return ad.localeCompare(bd) * direction || a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) * direction;
  });
}
