import { describe, it, expect } from 'vitest';
import { expandDailyPlanner } from '../../src/templates/daily-planner';
import { expandDailyFinance } from '../../src/templates/daily-finance';
import { expandGoalTracker } from '../../src/templates/goal-tracker';
import { expandProjectTracker } from '../../src/templates/project-tracker';
import { expandReadingLog } from '../../src/templates/reading-log';
import { expandFinancePlanner } from '../../src/templates/finance-planner';
import { expandTemplate } from '../../src/templates/template-registry';
import { PlannerSchema } from '../../src/types';

function emptySchema(overrides: Partial<PlannerSchema> = {}): PlannerSchema {
  return { columns: [], data: [], ...overrides };
}

function validatePlannerSchema(schema: PlannerSchema) {
  expect(schema.columns).toBeDefined();
  expect(Array.isArray(schema.columns)).toBe(true);
  expect(schema.data).toBeDefined();
  expect(Array.isArray(schema.data)).toBe(true);
  // Every column should have id, label, type
  for (const col of schema.columns) {
    expect(col.id).toBeTruthy();
    expect(col.label).toBeTruthy();
    expect(col.type).toBeTruthy();
  }
}

describe('expandDailyPlanner', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandDailyPlanner(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('daily-planner');
  });

  it('has subtables', () => {
    const result = expandDailyPlanner(emptySchema());
    expect(result._subtables).toBeDefined();
    expect(result._subtables!.length).toBeGreaterThan(0);
  });

  it('generates schedule time slots', () => {
    const result = expandDailyPlanner(emptySchema());
    const schedule = result._subtables!.find(t => t.title.includes('Schedule') || t.title.includes('Расписание'));
    expect(schedule).toBeDefined();
    expect(schedule!.data.length).toBeGreaterThan(0);
  });

  it('respects locale=en', () => {
    const result = expandDailyPlanner(emptySchema({ locale: 'en' }));
    expect(result.title).toContain('Daily Planner');
  });

  it('respects locale=ru (default)', () => {
    const result = expandDailyPlanner(emptySchema());
    expect(result.title).toContain('Ежедневник');
  });

  it('uses provided day', () => {
    const result = expandDailyPlanner(emptySchema({ day: '2024-06-15' } as PlannerSchema));
    expect(result.title).toContain('2024-06-15');
    expect(result['day']).toBe('2024-06-15');
  });

  it('uses provided sections data', () => {
    const habits = [{ habit: 'Running', description: '30 min', done: false }];
    const result = expandDailyPlanner(emptySchema({ sections: { habits } } as PlannerSchema));
    const habitTable = result._subtables!.find(t => t.title.includes('Привычки') || t.title.includes('Habits'));
    expect(habitTable!.data).toEqual(habits);
  });

  it('subtable columns have valid ids', () => {
    const result = expandDailyPlanner(emptySchema({ locale: 'en' }));
    for (const sub of result._subtables!) {
      for (const col of sub.columns) {
        expect(col.id).toBeTruthy();
        expect(typeof col.id).toBe('string');
      }
    }
  });
});

describe('expandDailyFinance', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandDailyFinance(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('daily-finance');
  });

  it('has income, fixed, variable, debts, savings subtables', () => {
    const result = expandDailyFinance(emptySchema({ locale: 'en' }));
    expect(result._subtables).toBeDefined();
    const titles = result._subtables!.map(t => t.title);
    expect(titles.some(t => t.includes('Income'))).toBe(true);
    expect(titles.some(t => t.includes('Fixed'))).toBe(true);
    expect(titles.some(t => t.includes('Variable'))).toBe(true);
    expect(titles.some(t => t.includes('Debts'))).toBe(true);
    expect(titles.some(t => t.includes('Savings'))).toBe(true);
  });

  it('uses provided day', () => {
    const result = expandDailyFinance(emptySchema({ day: '2024-03-20' } as PlannerSchema));
    expect(result.title).toContain('2024-03-20');
  });
});

describe('expandGoalTracker', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandGoalTracker(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('goal-tracker');
  });

  it('has progress column with formula', () => {
    const result = expandGoalTracker(emptySchema());
    const progressCol = result.columns.find(c => c.id === 'progress');
    expect(progressCol).toBeDefined();
    expect(progressCol!.formula).toBeDefined();
    expect(progressCol!.type).toBe('progress');
  });

  it('populates data from goals', () => {
    const goals = [{ objective: 'Ship v2', key_result: 'Release', target: 100, current: 50 }];
    const result = expandGoalTracker(emptySchema({ goals } as unknown as PlannerSchema));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].objective).toBe('Ship v2');
  });

  it('has summary definitions', () => {
    const result = expandGoalTracker(emptySchema());
    expect(result.summary).toBeDefined();
    expect(result.summary!.length).toBeGreaterThan(0);
  });

  it('column ids match data keys', () => {
    const goals = [{ objective: 'Goal1', key_result: 'KR1', target: 10, current: 5 }];
    const result = expandGoalTracker(emptySchema({ goals } as unknown as PlannerSchema));
    const colIds = result.columns.map(c => c.id);
    for (const row of result.data) {
      for (const key of Object.keys(row)) {
        expect(colIds).toContain(key);
      }
    }
  });
});

describe('expandProjectTracker', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandProjectTracker(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('project-tracker');
  });

  it('has progress column with color scale', () => {
    const result = expandProjectTracker(emptySchema());
    const progressCol = result.columns.find(c => c.id === 'progress');
    expect(progressCol).toBeDefined();
    expect(progressCol!.color_scale).toBeDefined();
  });

  it('populates data from tasks', () => {
    const tasks = [{ task: 'Build UI', status: '🔵 In Progress' }];
    const result = expandProjectTracker(emptySchema({ tasks, locale: 'en' } as unknown as PlannerSchema));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].task).toBe('Build UI');
  });

  it('includes project name in title', () => {
    const result = expandProjectTracker(emptySchema({ project: 'Alpha', locale: 'en' } as unknown as PlannerSchema));
    expect(result.title).toContain('Alpha');
  });
});

describe('expandReadingLog', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandReadingLog(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('reading-log');
  });

  it('has progress and rating columns', () => {
    const result = expandReadingLog(emptySchema());
    expect(result.columns.find(c => c.id === 'progress')).toBeDefined();
    expect(result.columns.find(c => c.id === 'rating')).toBeDefined();
  });

  it('populates data from books', () => {
    const books = [{ title: 'Atomic Habits', author: 'James Clear', pages: 320, read: 320, rating: 9 }];
    const result = expandReadingLog(emptySchema({ books } as unknown as PlannerSchema));
    expect(result.data).toHaveLength(1);
    expect(result.data[0].title).toBe('Atomic Habits');
  });

  it('has summary', () => {
    const result = expandReadingLog(emptySchema());
    expect(result.summary).toBeDefined();
    expect(result.summary!.length).toBeGreaterThan(0);
  });
});

describe('expandFinancePlanner', () => {
  it('returns a valid PlannerSchema', () => {
    const result = expandFinancePlanner(emptySchema());
    validatePlannerSchema(result);
    expect(result.template).toBe('finance-planner');
  });

  it('has subtables for income, fixed, variable, debts, savings', () => {
    const result = expandFinancePlanner(emptySchema({ locale: 'en' }));
    expect(result._subtables).toBeDefined();
    const titles = result._subtables!.map(t => t.title);
    expect(titles.some(t => t.includes('Income'))).toBe(true);
    expect(titles.some(t => t.includes('Fixed'))).toBe(true);
    expect(titles.some(t => t.includes('Variable'))).toBe(true);
    expect(titles.some(t => t.includes('Debts'))).toBe(true);
    expect(titles.some(t => t.includes('Savings'))).toBe(true);
  });

  it('has a monthly summary subtable', () => {
    const result = expandFinancePlanner(emptySchema({ locale: 'en' }));
    const summary = result._subtables!.find(t => t.title.includes('Summary'));
    expect(summary).toBeDefined();
  });

  it('computes summary data from sections', () => {
    const sections = {
      income: [{ category: 'Salary', planned: 5000, actual: 5000 }],
      fixed_expenses: [{ category: 'Rent', planned: 1000, actual: 1000 }],
    };
    const result = expandFinancePlanner(emptySchema({ sections, locale: 'en' } as PlannerSchema));
    // Summary data should have rows for each section
    expect(result.data.length).toBeGreaterThan(0);
  });
});

describe('expandTemplate — registry', () => {
  it('dispatches to correct template', () => {
    const result = expandTemplate(emptySchema({ template: 'reading-log' }));
    expect(result.template).toBe('reading-log');
    expect(result.columns.length).toBeGreaterThan(0);
  });

  it('returns schema unchanged when no template', () => {
    const schema = emptySchema({ title: 'Custom' });
    const result = expandTemplate(schema);
    expect(result).toBe(schema);
  });

  it('throws for unknown template', () => {
    expect(() => expandTemplate(emptySchema({ template: 'nonexistent' }))).toThrow('Unknown template');
  });

  it('supports all registered templates', () => {
    const templates = ['daily-planner', 'daily-finance', 'finance-planner', 'project-tracker', 'reading-log', 'goal-tracker'];
    for (const tmpl of templates) {
      const result = expandTemplate(emptySchema({ template: tmpl }));
      expect(result.template).toBe(tmpl);
      validatePlannerSchema(result);
    }
  });
});
