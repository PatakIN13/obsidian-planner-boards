import { PlannerSchema } from '../types';
import { expandDailyPlanner } from './daily-planner';
import { expandDailyFinance } from './daily-finance';
import { expandFinancePlanner } from './finance-planner';
import { expandProjectTracker } from './project-tracker';
import { expandReadingLog } from './reading-log';
import { expandGoalTracker } from './goal-tracker';

const templateExpanders: Record<string, (schema: PlannerSchema) => PlannerSchema> = {
  'daily-planner': expandDailyPlanner,
  'daily-finance': expandDailyFinance,
  'finance-planner': expandFinancePlanner,
  'project-tracker': expandProjectTracker,
  'reading-log': expandReadingLog,
  'goal-tracker': expandGoalTracker,
};

export function expandTemplate(schema: PlannerSchema): PlannerSchema {
  const templateName = schema.template;
  if (!templateName) return schema;

  const expander = templateExpanders[templateName];
  if (!expander) {
    throw new Error(`Unknown template: "${templateName}". Available: ${Object.keys(templateExpanders).join(', ')}`);
  }

  return expander(schema);
}
