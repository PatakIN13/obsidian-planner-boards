import { PlannerSchema, ColumnDef } from '../types';

export function expandDailyFinance(schema: PlannerSchema): PlannerSchema {
  const locale = (schema.locale as string) || 'ru';
  const isRu = locale === 'ru';
  let day = schema['day'] as string | Date | undefined;
  if (day instanceof Date) {
    day = day.toISOString().substring(0, 10);
  } else if (day && typeof day !== 'string') {
    day = String(day);
  }
  const month = (schema['month'] as string) || (day ? day.substring(0, 7) : getCurrentMonth());
  const sections = (schema.sections as Record<string, Record<string, string | number | boolean>[]>) || {};

  // ── Income ──
  const incomeColumns: ColumnDef[] = [
    { id: 'source', label: isRu ? 'Источник' : 'Source', type: 'text', width: 200, frozen: true },
    { id: 'amount', label: isRu ? 'Сумма' : 'Amount', type: 'number', min: 0, width: 100 },
    { id: 'comment', label: isRu ? 'Комментарий' : 'Comment', type: 'text', width: 200 },
  ];
  const incomeData = sections.income || [{ source: '', amount: '', comment: '' }];

  // ── Fixed Expenses ──
  const fixedCategories = (schema['fixedCategories'] as string[]) || (isRu
    ? ['Аренда/Ипотека', 'Коммунальные', 'Зал', 'Интернет/Связь', 'Страховка', 'Налоги', 'Другое']
    : ['Rent/Mortgage', 'Utilities', 'Gym', 'Internet/Phone', 'Insurance', 'Taxes', 'Other']);
  const fixedColumns: ColumnDef[] = [
    { id: 'category', label: isRu ? 'Категория' : 'Category', type: 'select', options: fixedCategories, width: 180 },
    { id: 'description', label: isRu ? 'Описание' : 'Description', type: 'text', width: 180 },
    { id: 'amount', label: isRu ? 'Сумма' : 'Amount', type: 'number', min: 0, width: 100 },
  ];
  const fixedData = sections.fixed_expenses || [{ category: '', description: '', amount: '' }];

  // ── Variable Expenses ──
  const variableCategories = (schema['variableCategories'] as string[]) || (isRu
    ? ['Продукты', 'Кафе/Рестораны', 'Медицина', 'Развлечения', 'Одежда', 'Путешествия', 'Бензин', 'Транспорт', 'Уход за собой', 'Подарки', 'Хобби', 'Другое']
    : ['Groceries', 'Dining', 'Medical', 'Entertainment', 'Clothing', 'Travel', 'Gas', 'Transport', 'Self-care', 'Gifts', 'Hobbies', 'Other']);
  const variableColumns: ColumnDef[] = [
    { id: 'category', label: isRu ? 'Категория' : 'Category', type: 'select', options: variableCategories, width: 160 },
    { id: 'description', label: isRu ? 'Описание' : 'Description', type: 'text', width: 200 },
    { id: 'amount', label: isRu ? 'Сумма' : 'Amount', type: 'number', min: 0, width: 100 },
    { id: 'comment', label: isRu ? 'Комментарий' : 'Comment', type: 'text', width: 160 },
  ];
  const variableData = sections.variable_expenses || [{ category: '', description: '', amount: '', comment: '' }];

  // ── Debts ──
  const debtColumns: ColumnDef[] = [
    { id: 'creditor', label: isRu ? 'Кредитор' : 'Creditor', type: 'text', width: 200, frozen: true },
    { id: 'amount', label: isRu ? 'Сумма' : 'Amount', type: 'number', min: 0, width: 100 },
    { id: 'comment', label: isRu ? 'Комментарий' : 'Comment', type: 'text', width: 200 },
  ];
  const debtData = sections.debts || [{ creditor: '', amount: '', comment: '' }];

  // ── Savings ──
  const savingsColumns: ColumnDef[] = [
    { id: 'goal', label: isRu ? 'Цель' : 'Goal', type: 'text', width: 200, frozen: true },
    { id: 'amount', label: isRu ? 'Сумма' : 'Amount', type: 'number', min: 0, width: 100 },
    { id: 'comment', label: isRu ? 'Комментарий' : 'Comment', type: 'text', width: 200 },
  ];
  const savingsData = sections.savings || [{ goal: '', amount: '', comment: '' }];

  const dateLabel = day || month;
  const title = (schema.title as string) || `💰 ${isRu ? 'Финансы' : 'Finance'} — ${dateLabel}`;

  return {
    type: 'grid',
    title,
    theme: (schema.theme as string) || 'soft',
    locale,
    template: 'daily-finance',
    ...(day ? { day } : { month }),
    sections: {
      income: incomeData,
      fixed_expenses: fixedData,
      variable_expenses: variableData,
      debts: debtData,
      savings: savingsData,
    },
    columns: variableColumns,
    summary: [],
    data: variableData,
    _subtables: [
      { title: isRu ? '💵 Доходы' : '💵 Income', columns: incomeColumns, data: incomeData, group: 'main', groupCol: 'left' },
      { title: isRu ? '🏠 Обязательные расходы' : '🏠 Fixed Expenses', columns: fixedColumns, data: fixedData, group: 'main', groupCol: 'left' },
      { title: isRu ? '🛒 Переменные расходы' : '🛒 Variable Expenses', columns: variableColumns, data: variableData, group: 'main', groupCol: 'right' },
      { title: isRu ? '💳 Долги' : '💳 Debts', columns: debtColumns, data: debtData, group: 'main', groupCol: 'right' },
      { title: isRu ? '🏦 Накопления' : '🏦 Savings', columns: savingsColumns, data: savingsData, group: 'main', groupCol: 'right' },
    ],
  };
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
