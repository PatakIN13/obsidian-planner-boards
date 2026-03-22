import { PlannerSchema, ColumnDef } from '../types';

export function expandFinancePlanner(schema: PlannerSchema): PlannerSchema {
  const locale = (schema.locale as string) || 'ru';
  const currency = (schema['currency'] as string) || '₽';
  const month = (schema['month'] as string) || getCurrentMonth();
  const sections = (schema.sections as Record<string, Record<string, string | number | boolean>[]>) || {};
  const isRu = locale === 'ru';

  // Define section configs
  const sectionDefs: { key: string; icon: string; titleRu: string; titleEn: string; dataKey: string; catField: string }[] = [
    { key: 'income', icon: '💵', titleRu: 'Доходы', titleEn: 'Income', dataKey: 'income', catField: 'category' },
    { key: 'fixed', icon: '🏠', titleRu: 'Обязательные расходы', titleEn: 'Fixed Expenses', dataKey: 'fixed_expenses', catField: 'category' },
    { key: 'variable', icon: '🛒', titleRu: 'Переменные расходы', titleEn: 'Variable Expenses', dataKey: 'variable_expenses', catField: 'category' },
    { key: 'debts', icon: '💳', titleRu: 'Долги', titleEn: 'Debts', dataKey: 'debts', catField: 'creditor' },
    { key: 'savings', icon: '🏦', titleRu: 'Накопления', titleEn: 'Savings', dataKey: 'savings', catField: 'goal' },
  ];

  const subtables: { title: string; columns: ColumnDef[]; data: Record<string, string | number | boolean>[] }[] = [];

  // Build a subtable for each section
  for (const def of sectionDefs) {
    const cols: ColumnDef[] = [
      { id: `${def.key}_cat`, label: isRu ? 'Подкатегория' : 'Subcategory', type: 'text', width: 200, frozen: true },
      { id: `${def.key}_planned`, label: isRu ? 'План' : 'Planned', type: 'number', width: 100 },
      { id: `${def.key}_actual`, label: isRu ? 'Факт' : 'Actual', type: 'number', width: 100 },
      { id: `${def.key}_diff`, label: isRu ? 'Разница' : 'Diff', type: 'formula',
        formula: `${def.key}_actual - ${def.key}_planned`,
        color_scale: { [-99999]: '#ff4444', 0: '#888888', [1]: '#44bb44' },
      },
    ];

    const sectionData = sections[def.dataKey] || [];
    const data: Record<string, string | number | boolean>[] = sectionData.map((item: Record<string, string | number | boolean>) => ({
      [`${def.key}_cat`]: item[def.catField] || item['category'] || '',
      [`${def.key}_planned`]: item['planned'] || item['payment'] || item['target'] || 0,
      [`${def.key}_actual`]: item['actual'] || item['paid'] || item['current'] || 0,
    }));

    if (data.length === 0) {
      data.push({
        [`${def.key}_cat`]: '',
        [`${def.key}_planned`]: 0,
        [`${def.key}_actual`]: 0,
      });
    }

    subtables.push({
      title: `${def.icon} ${isRu ? def.titleRu : def.titleEn}`,
      columns: cols,
      data,
    });
  }

  // Summary table
  const summaryColumns: ColumnDef[] = [
    { id: 'sum_cat', label: isRu ? 'Категория' : 'Category', type: 'text', width: 200, frozen: true },
    { id: 'sum_planned', label: isRu ? 'План' : 'Planned', type: 'number', width: 100 },
    { id: 'sum_actual', label: isRu ? 'Факт' : 'Actual', type: 'number', width: 100 },
    { id: 'sum_diff', label: isRu ? 'Разница' : 'Diff', type: 'formula',
      formula: 'sum_actual - sum_planned',
      color_scale: { [-99999]: '#ff4444', 0: '#888888', [1]: '#44bb44' },
    },
  ];

  // Calculate summary data from sections
  const summaryData: Record<string, string | number | boolean>[] = [];
  for (const def of sectionDefs) {
    const sectionItems = sections[def.dataKey] || [];
    let totalPlanned = 0, totalActual = 0;
    for (const item of sectionItems) {
      totalPlanned += (Number(item['planned'] || item['payment'] || item['target'] || 0));
      totalActual += (Number(item['actual'] || item['paid'] || item['current'] || 0));
    }
    summaryData.push({
      sum_cat: `${def.icon} ${isRu ? def.titleRu : def.titleEn}`,
      sum_planned: totalPlanned,
      sum_actual: totalActual,
    });
  }

  subtables.unshift({
    title: isRu ? '📊 Сводка за месяц' : '📊 Monthly Summary',
    columns: summaryColumns,
    data: summaryData,
  });

  const monthNames: Record<string, string[]> = {
    ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
         'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    en: ['January', 'February', 'March', 'April', 'May', 'June',
         'July', 'August', 'September', 'October', 'November', 'December'],
  };
  const [yearN, monthN] = month.split('-').map(Number);
  const names = monthNames[locale] || monthNames['ru'];
  const title = (schema.title as string) || `💰 ${isRu ? 'Финансы' : 'Finance'} — ${names[monthN - 1]} ${yearN}`;

  // Use summary as main grid columns/data
  return {
    type: 'grid',
    title,
    theme: (schema.theme as string) || 'soft',
    locale,
    template: 'finance-planner',
    month,
    currency,
    sections: schema.sections,
    columns: summaryColumns,
    summary: [
      { column: 'sum_planned', formula: 'SUM(sum_planned)', label: isRu ? 'Итого' : 'Total' },
      { column: 'sum_actual', formula: 'SUM(sum_actual)', label: isRu ? 'Итого' : 'Total' },
    ],
    data: summaryData,
    _subtables: subtables,
  };
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
