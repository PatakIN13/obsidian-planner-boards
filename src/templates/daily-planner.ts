import { PlannerSchema, ColumnDef } from '../types';

export function expandDailyPlanner(schema: PlannerSchema): PlannerSchema {
  const locale = (schema.locale as string) || 'ru';
  const isRu = locale === 'ru';
  let day = schema['day'] as string | Date | undefined;
  if (day instanceof Date) {
    day = day.toISOString().substring(0, 10);
  } else if (day && typeof day !== 'string') {
    day = String(day);
  }
  const month = (schema['month'] as string) || (day ? day.substring(0, 7) : getCurrentMonth());
  const categories = (schema['categories'] as string[]) || (isRu
    ? ['Работа', 'Личное', 'Здоровье', 'Учёба', 'Другое']
    : ['Work', 'Personal', 'Health', 'Study', 'Other']);
  const weeklyPriorities = (schema['weeklyPriorities'] as string[]) || (isRu
    ? ['🔴 Срочно / Важно', '🟡 Не срочно / Важно', '🟠 Срочно / Не важно', '🟢 Не срочно / Не важно']
    : ['🔴 Urgent / Important', '🟡 Not Urgent / Important', '🟠 Urgent / Not Important', '🟢 Not Urgent / Not Important']);
  const dailyPriorities = (schema['dailyPriorities'] as string[]) || (isRu
    ? ['🔴 Важно', '🟡 Средне', '🟢 Не важно']
    : ['🔴 Important', '🟡 Medium', '🟢 Not Important']);
  const timeInterval = (schema['timeInterval'] as number) || 60; // 15, 30, 45, 60

  const tasksTitle = isRu ? '✅ Ежедневные' : '✅ Daily';

  // --- HABITS TABLE (top, expanded with description) ---
  const habitColumns: ColumnDef[] = [
    { id: 'done', label: '✓', type: 'checkbox', width: 40 },
    { id: 'habit', label: isRu ? 'Привычка' : 'Habit', type: 'text', width: 180, frozen: true },
    { id: 'description', label: isRu ? 'Описание' : 'Description', type: 'text', width: 280 },
  ];
  const defaultHabits = isRu
    ? [
        { habit: 'Зарядка', description: '15 мин утром', done: false },
        { habit: 'Чтение', description: '30 мин', done: false },
        { habit: 'Вода', description: '8 стаканов за день', done: false },
        { habit: 'Медитация', description: '10 мин', done: false },
        { habit: '', description: '', done: false },
      ]
    : [
        { habit: 'Exercise', description: '15 min morning', done: false },
        { habit: 'Reading', description: '30 min', done: false },
        { habit: 'Water', description: '8 glasses a day', done: false },
        { habit: 'Meditation', description: '10 min', done: false },
        { habit: '', description: '', done: false },
      ];
  const habitData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.habits || defaultHabits;

  // --- WEEKLY TASKS TABLE ---
  const weeklyTaskColumns: ColumnDef[] = [
    { id: 'done', label: '✓', type: 'checkbox' },
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'text', width: 250 },
    { id: 'priority', label: isRu ? 'Приоритет' : 'Priority', type: 'select', options: weeklyPriorities },
    { id: 'category', label: isRu ? 'Категория' : 'Category', type: 'select', options: categories },
    { id: 'goal', label: isRu ? '🎯 Цель' : '🎯 Goal', type: 'text', width: 160 },
    { id: 'completedDate', label: isRu ? 'Завершено' : 'Completed', type: 'text', width: 100 },
  ];
  const weeklyTaskData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.weeklyTasks || [
    { done: false, task: '', priority: '', category: '', goal: '', completedDate: '' },
  ];

  // --- MONTHLY TASKS TABLE ---
  const monthlyTaskColumns: ColumnDef[] = [
    { id: 'done', label: '✓', type: 'checkbox' },
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'text', width: 250 },
    { id: 'priority', label: isRu ? 'Приоритет' : 'Priority', type: 'select', options: weeklyPriorities },
    { id: 'category', label: isRu ? 'Категория' : 'Category', type: 'select', options: categories },
    { id: 'goal', label: isRu ? '🎯 Цель' : '🎯 Goal', type: 'text', width: 160 },
    { id: 'completedDate', label: isRu ? 'Завершено' : 'Completed', type: 'text', width: 100 },
  ];
  const monthlyTaskData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.monthlyTasks || [
    { done: false, task: '', priority: '', category: '', goal: '', completedDate: '' },
  ];

  // --- TASKS TABLE ---
  const taskColumns: ColumnDef[] = [
    { id: 'done', label: '✓', type: 'checkbox' },
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'text', width: 250 },
    { id: 'priority', label: isRu ? 'Приоритет' : 'Priority', type: 'select', options: dailyPriorities },
    { id: 'category', label: isRu ? 'Категория' : 'Category', type: 'select', options: categories },
  ];
  const taskData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.tasks || [
    { done: false, task: '', priority: '', category: '' },
  ];

  // --- SCHEDULE TABLE (multi-select references tasks) ---
  const scheduleColumns: ColumnDef[] = [
    { id: 'time', label: isRu ? 'Время' : 'Time', type: 'text', width: 70, frozen: true },
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'combo', width: 280, refTables: [tasksTitle, isRu ? '🎯 Задачи на неделю' : '🎯 Weekly Tasks', isRu ? '📆 Задачи на месяц' : '📆 Monthly Tasks'], refColumn: 'task', multiSelect: true },
  ];
  const hours = generateTimeSlots(timeInterval);
  const scheduleData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.schedule || hours.map((h: string) => ({
    time: h, task: '', _mins: '',
  }));

  // --- NOTES TABLE (combo references tasks) ---
  const noteColumns: ColumnDef[] = [
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'combo', width: 200, refTables: [tasksTitle, isRu ? '🎯 Задачи на неделю' : '🎯 Weekly Tasks', isRu ? '📆 Задачи на месяц' : '📆 Monthly Tasks'], refColumn: 'task' },
    { id: 'note', label: isRu ? 'Заметка' : 'Note', type: 'text', width: 400 },
  ];
  const noteData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.notes || [{ task: '', note: '' }];

  // --- MOOD TABLE ---
  const moodColumns: ColumnDef[] = [
    { id: 'metric', label: isRu ? 'Показатель' : 'Metric', type: 'text', width: 160, frozen: true },
    { id: 'value', label: isRu ? 'Оценка' : 'Rating', type: 'number', min: 1, max: 10, width: 80 },
  ];
  const defaultMood = isRu
    ? [
        { metric: '😊 Настроение', value: '' },
        { metric: '⚡ Энергия', value: '' },
        { metric: '🧘 Спокойствие', value: '' },
        { metric: '', value: '' },
      ]
    : [
        { metric: '😊 Mood', value: '' },
        { metric: '⚡ Energy', value: '' },
        { metric: '🧘 Calm', value: '' },
        { metric: '', value: '' },
      ];
  const moodData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.mood || defaultMood;

  // --- EXERCISE TABLE ---
  const exerciseColumns: ColumnDef[] = [
    { id: 'exercise', label: isRu ? 'Упражнение' : 'Exercise', type: 'text', width: 160, frozen: true },
    { id: 'value', label: isRu ? 'Значение' : 'Value', type: 'number', min: 0, width: 80 },
    { id: 'unit', label: isRu ? 'Ед.' : 'Unit', type: 'text', width: 60 },
  ];
  const defaultExercise = isRu
    ? [
        { exercise: '', value: '', unit: '' },
      ]
    : [
        { exercise: '', value: '', unit: '' },
      ];
  const exerciseData = (schema.sections as Record<string, Record<string, string | number | boolean>[]> | undefined)?.exercise || defaultExercise;

  const dateLabel = day || month;
  const title = (schema.title as string) || `📅 ${isRu ? 'Ежедневник' : 'Daily Planner'} — ${dateLabel}`;

  return {
    type: 'grid',
    title,
    theme: (schema.theme as string) || 'soft',
    locale,
    template: 'daily-planner',
    ...(day ? { day } : { month }),
    categories,
    timeInterval,
    sections: { habits: habitData, weeklyTasks: weeklyTaskData, monthlyTasks: monthlyTaskData, tasks: taskData, schedule: scheduleData, notes: noteData, mood: moodData, exercise: exerciseData },
    columns: taskColumns,
    summary: [],
    data: taskData,
    _subtables: [
      { title: isRu ? '🔄 Привычки' : '🔄 Habits', columns: habitColumns, data: habitData },
      { title: isRu ? '📆 Задачи на месяц' : '📆 Monthly Tasks', columns: monthlyTaskColumns, data: monthlyTaskData, group: 'main', groupCol: 'left' },
      { title: isRu ? '🎯 Задачи на неделю' : '🎯 Weekly Tasks', columns: weeklyTaskColumns, data: weeklyTaskData, group: 'main', groupCol: 'left' },
      { title: tasksTitle, columns: taskColumns, data: taskData, group: 'main', groupCol: 'left' },
      {
        title: isRu ? '📅 Расписание' : '📅 Schedule',
        columns: scheduleColumns, data: scheduleData, group: 'main', groupCol: 'right',
        noAddRow: true,
        controls: [{
          type: 'select', field: 'timeInterval', value: timeInterval,
          options: [
            { label: '15 ' + (isRu ? 'мин' : 'min'), value: 15 },
            { label: '30 ' + (isRu ? 'мин' : 'min'), value: 30 },
            { label: '45 ' + (isRu ? 'мин' : 'min'), value: 45 },
            { label: '60 ' + (isRu ? 'мин' : 'min'), value: 60 },
          ],
        }],
      },
      { title: isRu ? '🌟 Самочувствие' : '🌟 Mood', columns: moodColumns, data: moodData, group: 'main', groupCol: 'right' },
      { title: isRu ? '🏋️ Тренировки' : '🏋️ Exercise', columns: exerciseColumns, data: exerciseData, group: 'main', groupCol: 'right' },
      { title: isRu ? '📝 Заметки' : '📝 Notes', columns: noteColumns, data: noteData },
    ],
  };
}

function generateTimeSlots(interval: number): string[] {
  const slots: string[] = [];
  for (let m = 360; m <= 1320; m += interval) { // 06:00 to 22:00
    const h = Math.floor(m / 60);
    const min = m % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return slots;
}

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
