import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "../src/app/(app)/plan/page.tsx"), "utf8");
const dashboard = readFileSync(path.resolve(__dirname, "../src/app/(app)/dashboard/page.tsx"), "utf8");

describe("M4.5 Goals experience", () => {
  it("summarizes savings goals before individual goal cards", () => {
    expect(src).toContain('id="goals-overview-heading"');
    expect(src).toContain('label="Saved toward goals"');
    expect(src).toContain('label="Remaining to targets"');
    expect(src).toContain('label="Needs pace adjustment"');
    expect(src.indexOf('id="goals-overview-heading"')).toBeLessThan(src.indexOf('<CardTitle>Savings goals</CardTitle>'));
  });

  it("uses the domain pace requirement to surface goals that need attention", () => {
    expect(src).toContain('function goalNeedsPace(g: Goal, today: string): boolean');
    expect(src).toContain('if (g.target_date < today) return true;');
    expect(src).toContain('return (g.monthly_contribution_cents ?? 0) < g.requiredMonthlyCents;');
    expect(src).toContain('"Adjust pace"');
    expect(src).toContain('"On pace"');
    expect(src).toContain('Increase monthly saving by');
    expect(src).toContain('Goals that need a pace adjustment appear first; completed goals stay visible.');
  });

  it("supports editing an existing savings goal through the existing planning API", () => {
    expect(src).toContain('const [editingGoalId, setEditingGoalId] = useState<string | null>(null);');
    expect(src).toContain('api.patch(`/api/planning/goals/${editingGoalId}`');
    expect(src).toContain('contributionMode: goalContribution ? "interval" : "none"');
    expect(src).toContain('contributionInterval: goalContribution ? "monthly" : null');
    expect(src).toContain('onClick={() => openEditGoal(g)}');
    expect(src).toContain('aria-label={`Edit goal ${g.name}`}');
    expect(src).toContain('editingGoalId ? "Save goal" : "Add goal"');
  });

  it("surfaces savings goal progress on Overview", () => {
    expect(dashboard).toContain('function GoalsCard({ goals, loading, failed }');
    expect(dashboard).toContain('api.get<{ goals: OverviewGoal[] }>("/api/planning/goals")');
    expect(dashboard).toContain('<CardTitle>Goals</CardTitle>');
    expect(dashboard).toContain('href="/plan#goals-overview-heading"');
    expect(dashboard).toContain('goal progress on overview');
  });

  it("keeps completion and progress visible without allowing the progress bar over 100 percent", () => {
    expect(src).toContain('const complete = g.current_cents >= g.target_cents;');
    expect(src).toContain('<Progress value={Math.min(1, g.pct)} label={`${g.name} goal progress`} />');
    expect(src).toContain('complete ? "Complete"');
  });
});

[executed on device: aubrieta (7aba6798-e9cc-49d5-b00e-694dfe832d6e)]