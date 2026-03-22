import { PlannerSchema, ColumnDef } from '../types';

export function expandProjectTracker(schema: PlannerSchema): PlannerSchema {
  const input = schema as any;
  const locale = input.locale || 'ru';
  const isRu = locale === 'ru';

  const statuses = input.statuses || [
    isRu ? '⬜ Ожидает' : '⬜ Pending',
    isRu ? '🔵 В работе' : '🔵 In Progress',
    isRu ? '🟡 Ревью' : '🟡 Review',
    isRu ? '✅ Готово' : '✅ Done',
  ];
  const priorities = input.priorities || [
    isRu ? '🔴 Высокий' : '🔴 High',
    isRu ? '🟠 Средний' : '🟠 Medium',
    isRu ? '🟢 Низкий' : '🟢 Low',
  ];
  const assignees: string[] = input.assignees || [];

  const columns: ColumnDef[] = [
    { id: 'task', label: isRu ? 'Задача' : 'Task', type: 'text', width: 220, frozen: true },
    { id: 'assignee', label: isRu ? 'Исполнитель' : 'Assignee', type: 'select', options: assignees },
    { id: 'status', label: isRu ? 'Статус' : 'Status', type: 'select', options: statuses },
    { id: 'priority', label: isRu ? 'Приоритет' : 'Priority', type: 'select', options: priorities },
    { id: 'deadline', label: isRu ? 'Дедлайн' : 'Deadline', type: 'date' },
    { id: 'progress', label: isRu ? 'Прогресс' : 'Progress', type: 'progress', min: 0, max: 100,
      color_scale: { 0: '#ff4444', 50: '#ffaa00', 80: '#44bb44', 100: '#22aa22' }
    },
  ];

  const data: Record<string, any>[] = (input.tasks || input.data || []).map((t: any) => ({
    task: t.task || t.text || '',
    assignee: t.assignee || '',
    status: t.status || statuses[0],
    priority: t.priority || priorities[1],
    deadline: t.deadline || '',
    progress: t.progress ?? 0,
  }));

  const title = input.title || `🚀 ${isRu ? 'Проект' : 'Project'}${input.project ? ': ' + input.project : ''}`;

  return {
    type: 'grid',
    title,
    theme: input.theme || 'soft',
    locale,
    template: 'project-tracker',
    project: input.project,
    assignees,
    tasks: input.tasks,
    columns,
    summary: [
      { column: 'progress', formula: 'AVG(progress)', label: isRu ? 'Общий прогресс' : 'Overall' },
    ],
    data,
  };
}
