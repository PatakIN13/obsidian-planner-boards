import { PlannerSchema, ColumnDef } from '../types';

/**
 * Reading log: track books with status, rating, pages.
 *
 * Input:
 *   template: reading-log
 *   books:
 *     - title: "Atomic Habits"
 *       author: "James Clear"
 *       pages: 320
 *       read: 320
 *       rating: 9
 *       status: "✅ Прочитано"
 */
export function expandReadingLog(schema: PlannerSchema): PlannerSchema {
  const locale = (schema.locale as string) || 'ru';
  const isRu = locale === 'ru';

  const statuses = (schema['statuses'] as string[]) || [
    isRu ? '📖 Читаю' : '📖 Reading',
    isRu ? '⏸️ Пауза' : '⏸️ Paused',
    isRu ? '✅ Прочитано' : '✅ Finished',
    isRu ? '📋 В очереди' : '📋 To Read',
  ];

  const columns: ColumnDef[] = [
    { id: 'title', label: isRu ? 'Название' : 'Title', type: 'text', width: 200, frozen: true },
    { id: 'author', label: isRu ? 'Автор' : 'Author', type: 'text', width: 150 },
    { id: 'status', label: isRu ? 'Статус' : 'Status', type: 'select', options: statuses },
    { id: 'pages', label: isRu ? 'Страниц' : 'Pages', type: 'number', min: 0 },
    { id: 'read', label: isRu ? 'Прочитано' : 'Read', type: 'number', min: 0 },
    {
      id: 'progress', label: '%', type: 'progress',
      formula: 'ROUND(read / pages * 100)',
      min: 0, max: 100,
      color_scale: { 0: '#ff4444', 50: '#ffaa00', 100: '#22aa22' },
    },
    {
      id: 'rating', label: isRu ? 'Оценка' : 'Rating', type: 'number',
      min: 1, max: 10,
      color_scale: { 1: '#ff4444', 5: '#ffaa00', 8: '#44bb44', 10: '#22aa22' },
    },
    { id: 'notes', label: isRu ? 'Заметки' : 'Notes', type: 'text', width: 200 },
  ];

  const data = ((schema['books'] || []) as Record<string, string | number | boolean>[]).map((b: Record<string, string | number | boolean>) => ({
    title: b['title'] || '',
    author: b['author'] || '',
    status: b['status'] || statuses[3],
    pages: b['pages'] ?? 0,
    read: b['read'] ?? 0,
    rating: b['rating'] ?? '',
    notes: b['notes'] || '',
  }));

  return {
    type: 'grid',
    title: (schema.title as string) || `📚 ${isRu ? 'Журнал чтения' : 'Reading Log'}`,
    theme: (schema.theme as string) || 'soft',
    locale,
    template: 'reading-log',
    books: schema['books'],
    columns,
    summary: [
      { column: 'rating', formula: 'AVG(rating)', label: isRu ? 'Средняя оценка' : 'Avg Rating' },
    ],
    data,
  };
}
