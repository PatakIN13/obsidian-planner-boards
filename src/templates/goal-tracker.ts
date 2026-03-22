import { PlannerSchema, ColumnDef } from '../types';

export function expandGoalTracker(schema: PlannerSchema): PlannerSchema {
  const locale = (schema.locale as string) || 'ru';
  const isRu = locale === 'ru';

  const statuses = (schema['statuses'] as string[]) || [
    isRu ? '⬜ Не начато' : '⬜ Not started',
    isRu ? '🔵 В процессе' : '🔵 In progress',
    isRu ? '✅ Достигнуто' : '✅ Achieved',
    isRu ? '❌ Отменено' : '❌ Cancelled',
  ];

  const quarters = (schema['quarters'] as string[]) || ['Q1', 'Q2', 'Q3', 'Q4'];

  const columns: ColumnDef[] = [
    { id: 'objective', label: isRu ? 'Цель (Objective)' : 'Objective', type: 'text', width: 220, frozen: true },
    { id: 'key_result', label: isRu ? 'Ключевой результат' : 'Key Result', type: 'text', width: 220 },
    { id: 'quarter', label: isRu ? 'Квартал' : 'Quarter', type: 'select', options: quarters },
    { id: 'status', label: isRu ? 'Статус' : 'Status', type: 'select', options: statuses },
    { id: 'target', label: isRu ? 'Цель (число)' : 'Target', type: 'number', min: 0 },
    { id: 'current', label: isRu ? 'Текущий' : 'Current', type: 'number', min: 0 },
    { id: 'progress', label: isRu ? 'Прогресс' : 'Progress', type: 'progress', min: 0, max: 100,
      formula: 'ROUND(current / target * 100, 0)',
      color_scale: { 0: '#ff4444', 30: '#ff8800', 70: '#44bb44', 100: '#22aa22' }
    },
  ];

  const data: Record<string, string | number | boolean>[] = ((schema['goals'] || schema.data || []) as Record<string, string | number | boolean>[]).map((g: Record<string, string | number | boolean>) => ({
    objective: g['objective'] || '',
    key_result: g['key_result'] || '',
    quarter: g['quarter'] || quarters[0],
    status: g['status'] || statuses[0],
    target: g['target'] ?? 100,
    current: g['current'] ?? 0,
    progress: 0,
  }));

  const title = (schema.title as string) || `🎯 ${isRu ? 'OKR' : 'OKR'}${schema['year'] ? ' ' + String(schema['year'] as string | number) : ''}`;

  return {
    type: 'grid',
    title,
    theme: (schema.theme as string) || 'soft',
    locale,
    template: 'goal-tracker',
    year: schema['year'],
    goals: schema['goals'],
    columns,
    summary: [
      { column: 'progress', formula: 'AVG(progress)', label: isRu ? 'Общий прогресс' : 'Overall' },
      { column: 'status', formula: 'COUNTIF(status, ✅)', label: isRu ? 'Достигнуто' : 'Achieved' },
    ],
    data,
  };
}
