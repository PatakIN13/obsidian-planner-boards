import { ItemView, WorkspaceLeaf, setIcon, TFile } from 'obsidian';
import type PlannerBoardsPlugin from './main';
import { CalendarEvent } from './calendar/calendar-types';
import { parseSchema } from './parser/schema-parser';
import { expandTemplate } from './templates/template-registry';
import { t, tArray } from './i18n';

export const VIEW_TYPE_PLANNER = 'planner-boards-view';

/** Aggregated day data from daily planners/finance across boards */
interface DaySummary {
  hasPlan: boolean;
  hasFinance: boolean;
  tasksTotal: number;
  tasksDone: number;
  habitsTotal: number;
  habitsDone: number;
  income: number;
  expenses: number;
  tasks: { task: string; done: boolean; priority: string }[];
  habits: { habit: string; done: boolean }[];
  schedule: { time: string; task: string }[];
}

function emptyDay(): DaySummary {
  return { hasPlan: false, hasFinance: false, tasksTotal: 0, tasksDone: 0, habitsTotal: 0, habitsDone: 0, income: 0, expenses: 0, tasks: [], habits: [], schedule: [] };
}

/**
 * Hub / Dashboard — calendar + weekly aggregator + board cards.
 */
export class PlannerBoardsView extends ItemView {
  private plugin: PlannerBoardsPlugin;
  private contentContainer: HTMLElement;
  private headerEl: HTMLElement;
  private currentDate: Date = new Date();
  /** Cached day summaries keyed by "YYYY-MM-DD" */
  private dayCache: Record<string, DaySummary> = {};
  /** Board files that have show-on-main */
  private visibleBoards: { file: TFile; folder: string; plannerCount: number }[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: PlannerBoardsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_PLANNER; }
  getDisplayText(): string { return 'Planner boards'; }
  getIcon(): string { return 'layout-grid'; }

  /** Backward compat */
  setMode(_mode: string) {}

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('planner-boards-view-root');
    this.headerEl = container.createDiv({ cls: 'planner-view-header' });
    this.contentContainer = container.createDiv({ cls: 'planner-view-content' });
    await this.fullRefresh();
  }

  /** Scan vault, build cache, render */
  private async fullRefresh() {
    await this.scanVault();
    this.render();
  }

  // ── Data scanning ──

  private async scanVault() {
    this.dayCache = {};
    this.visibleBoards = [];
    const boardFiles = this.app.vault.getFiles().filter(f => f.extension === 'planner-board');

    for (const bf of boardFiles) {
      try {
        const bfContent = await this.app.vault.cachedRead(bf);
        const fmMatch = bfContent.match(/^---\n([\s\S]*?)\n---/);
        const fm = fmMatch ? fmMatch[1] : '';
        const showOnMain = !fm.includes('show-on-main: false');
        if (!showOnMain) continue;

        const folderMatch = fm.match(/folder:\s*["']?([^"'\n]+)/);
        const folder = folderMatch ? folderMatch[1].trim() : bf.parent?.path || '';

        const plannerFiles = this.app.vault.getFiles().filter(f =>
          f.path.startsWith(folder + '/') && f.extension === 'planner'
        );
        this.visibleBoards.push({ file: bf, folder, plannerCount: plannerFiles.length });

        for (const pf of plannerFiles) {
          try {
            const content = await this.app.vault.cachedRead(pf);
            const blocks = content.match(/```planner\n([\s\S]*?)```/g);
            if (!blocks) continue;

            for (const block of blocks) {
              const yaml = block.replace(/^```planner\n/, '').replace(/```$/, '').trim();
              const schema = parseSchema(yaml);
              const input = schema;
              const day = input.day as string | undefined;
              if (!day) continue;

              if (!this.dayCache[day]) this.dayCache[day] = emptyDay();
              const ds = this.dayCache[day];

              if (input.template === 'daily-planner') {
                ds.hasPlan = true;
                const expanded = expandTemplate(schema);
                const sections = expanded.sections as Record<string, Record<string, unknown>[]> || {};
                if (sections.tasks) {
                  for (const row of sections.tasks) {
                    if (row.task) {
                      ds.tasks.push({ task: row.task as string, done: !!row.done, priority: (row.priority as string) || '' });
                      ds.tasksTotal++;
                      if (row.done) ds.tasksDone++;
                    }
                  }
                }
                if (sections.habits) {
                  for (const row of sections.habits) {
                    if (row.habit) {
                      ds.habits.push({ habit: row.habit as string, done: !!row.done });
                      ds.habitsTotal++;
                      if (row.done) ds.habitsDone++;
                    }
                  }
                }
                if (sections.schedule) {
                  for (const row of sections.schedule) {
                    if (row.task) ds.schedule.push({ time: (row.time as string) || '', task: row.task as string });
                  }
                }
              }

              if (input.template === 'daily-finance') {
                ds.hasFinance = true;
                const expanded = expandTemplate(schema);
                const sections = expanded.sections as Record<string, Record<string, unknown>[]> || {};
                if (sections.income) {
                  for (const r of sections.income) ds.income += Number(r.amount) || 0;
                }
                for (const key of ['fixed_expenses', 'variable_expenses', 'debts', 'savings']) {
                  if (sections[key]) {
                    for (const r of sections[key]) ds.expenses += Number(r.amount) || 0;
                  }
                }
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  // ── Rendering ──

  private render() {
    this.headerEl.empty();
    this.contentContainer.empty();

    const isRu = (this.plugin.settings.uiLanguage || 'ru') === 'ru';
    const now = new Date();

    // Header
    const titleRow = this.headerEl.createDiv({ cls: 'planner-view-title-row' });
    titleRow.createEl('h2', { text: '📋 Planner boards', cls: 'planner-hub-title' });
    const actions = titleRow.createDiv({ cls: 'planner-view-actions' });
    const refreshBtn = actions.createEl('button', { cls: 'planner-view-action-btn', title: t('ui.refresh') });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.fullRefresh(); });

    const dashboard = this.contentContainer.createDiv({ cls: 'planner-hub' });

    // ── Row 1: Calendar + Weekly aggregator ──
    const topRow = dashboard.createDiv({ cls: 'planner-hub-row' });
    this.renderCalendar(topRow, isRu, now);
    this.renderWeekAggregator(topRow, isRu, now);

    // ── Row 2: Board cards ──
    this.renderBoardCards(dashboard, isRu);
  }

  // ── Calendar widget ──

  private renderCalendar(parent: HTMLElement, isRu: boolean, now: Date) {
    const widget = parent.createDiv({ cls: 'planner-hub-widget planner-hub-calendar' });
    const months = tArray('months.full');
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();

    // Navigation
    const nav = widget.createDiv({ cls: 'planner-hub-cal-nav' });
    const prevBtn = nav.createEl('button', { cls: 'planner-hub-cal-nav-btn' });
    setIcon(prevBtn, 'chevron-left');
    prevBtn.addEventListener('click', () => {
      this.currentDate.setMonth(this.currentDate.getMonth() - 1);
      this.render();
    });

    nav.createEl('span', { text: `${months[month]} ${year}`, cls: 'planner-hub-cal-title' });

    const todayBtn = nav.createEl('button', {
      text: isRu ? 'Сегодня' : 'Today',
      cls: 'planner-hub-cal-nav-btn planner-hub-cal-today-btn',
    });
    todayBtn.addEventListener('click', () => {
      this.currentDate = new Date();
      this.render();
    });

    const nextBtn = nav.createEl('button', { cls: 'planner-hub-cal-nav-btn' });
    setIcon(nextBtn, 'chevron-right');
    nextBtn.addEventListener('click', () => {
      this.currentDate.setMonth(this.currentDate.getMonth() + 1);
      this.render();
    });

    // Grid
    const grid = widget.createDiv({ cls: 'planner-hub-cal-grid' });
    const shortDays = tArray('days.short').slice(1).concat(tArray('days.short').slice(0, 1));
    for (const dn of shortDays) {
      grid.createDiv({ cls: 'planner-hub-cal-header', text: dn.substring(0, 2) });
    }

    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6;

    for (let i = 0; i < startDow; i++) grid.createDiv({ cls: 'planner-hub-cal-cell planner-hub-cal-empty' });

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const isToday = year === now.getFullYear() && month === now.getMonth() && d === now.getDate();
      const ds = this.dayCache[dateStr];
      const hasIcs = this.plugin.calendarSync
        ? this.plugin.calendarSync.getEventsForDay(new Date(year, month, d)).length > 0
        : false;

      const cell = grid.createDiv({ cls: `planner-hub-cal-cell ${isToday ? 'is-today' : ''}` });
      cell.createEl('span', { text: String(d), cls: 'planner-hub-cal-num' });

      // Indicator dots
      const dots = cell.createDiv({ cls: 'planner-hub-cal-dots' });
      if (ds?.hasPlan) dots.createEl('span', { cls: 'planner-hub-dot planner-hub-dot-plan', title: isRu ? 'Планер' : 'Planner' });
      if (ds?.hasFinance) dots.createEl('span', { cls: 'planner-hub-dot planner-hub-dot-fin', title: isRu ? 'Финансы' : 'Finance' });
      if (hasIcs) dots.createEl('span', { cls: 'planner-hub-dot planner-hub-dot-ics', title: isRu ? 'Календарь' : 'Calendar' });

      // Click → open first board navigated to that day
      cell.addEventListener('click', () => {
        if (this.visibleBoards.length > 0) {
          const board = this.visibleBoards[0];
          const leaf = this.app.workspace.getLeaf('tab');
          void leaf.openFile(board.file).then(() => {
            // Navigate to day after file loads
            setTimeout(() => {
              const view = leaf.view as ItemView & { navigateToDay?: (d: string) => void };
              if (view && typeof view.navigateToDay === 'function') {
                view.navigateToDay(dateStr);
              }
            }, 200);
          });
        }
      });
    }

    // ICS events today + tomorrow
    if (this.plugin.calendarSync) {
      const todayEvents = this.plugin.calendarSync.getEventsForDay(now);
      const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
      const tomorrowEvents = this.plugin.calendarSync.getEventsForDay(tomorrow);

      if (todayEvents.length > 0 || tomorrowEvents.length > 0) {
        const evWrap = widget.createDiv({ cls: 'planner-hub-events-wrap' });
        if (todayEvents.length > 0) {
          const sec = evWrap.createDiv({ cls: 'planner-hub-events' });
          sec.createEl('h4', { text: `${isRu ? 'Сегодня' : 'Today'} (${todayEvents.length})` });
          this.renderEventList(sec, todayEvents.slice(0, 4));
        }
        if (tomorrowEvents.length > 0) {
          const sec = evWrap.createDiv({ cls: 'planner-hub-events' });
          sec.createEl('h4', { text: `${isRu ? 'Завтра' : 'Tomorrow'} (${tomorrowEvents.length})` });
          this.renderEventList(sec, tomorrowEvents.slice(0, 3));
        }
      }
    }
  }

  // ── Weekly aggregator ──

  private renderWeekAggregator(parent: HTMLElement, isRu: boolean, now: Date) {
    const widget = parent.createDiv({ cls: 'planner-hub-widget planner-hub-week' });

    // Calculate current week Mon–Sun
    const monday = this.getMondayOfWeek(now);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    const dayNamesShort = tArray('days.short');
    // Reorder: Mon first
    const dayOrder = [1, 2, 3, 4, 5, 6, 0];

    const fmtDate = (d: Date) => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    widget.createEl('h3', { text: `📊 ${isRu ? 'Неделя' : 'Week'}: ${fmtDate(monday)} — ${fmtDate(sunday)}` });

    // Week totals
    let weekTasks = 0, weekTasksDone = 0, weekHabits = 0, weekHabitsDone = 0, weekIncome = 0, weekExpenses = 0;

    // Table
    const table = widget.createEl('table', { cls: 'planner-hub-week-table' });
    const thead = table.createEl('thead');
    const headRow = thead.createEl('tr');
    headRow.createEl('th', { text: isRu ? 'День' : 'Day' });
    headRow.createEl('th', { text: `✅ ${isRu ? 'Задачи' : 'Tasks'}` });
    headRow.createEl('th', { text: `🔄 ${isRu ? 'Привычки' : 'Habits'}` });
    headRow.createEl('th', { text: `📈 ${isRu ? 'Доход' : 'Income'}` });
    headRow.createEl('th', { text: `📉 ${isRu ? 'Расход' : 'Expense'}` });
    headRow.createEl('th', { text: `💰 ${isRu ? 'Баланс' : 'Balance'}` });

    const tbody = table.createEl('tbody');

    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const ds = this.dayCache[dateStr] || emptyDay();
      const isToday = this.isSameDay(date, now);
      const dow = dayOrder[i];

      weekTasks += ds.tasksTotal; weekTasksDone += ds.tasksDone;
      weekHabits += ds.habitsTotal; weekHabitsDone += ds.habitsDone;
      weekIncome += ds.income; weekExpenses += ds.expenses;
      const balance = ds.income - ds.expenses;

      const row = tbody.createEl('tr', { cls: isToday ? 'planner-hub-week-today' : '' });

      // Day name + date
      const dayCell = row.createEl('td', { cls: 'planner-hub-week-day' });
      dayCell.createEl('span', { text: dayNamesShort[dow], cls: 'planner-hub-week-dayname' });
      dayCell.createEl('span', { text: ` ${date.getDate()}`, cls: 'planner-hub-week-daynum' });

      // Status dots
      if (!ds.hasPlan && !ds.hasFinance) {
        dayCell.createEl('span', { text: ' ⚪', cls: 'planner-hub-week-nodot' });
      }

      // Tasks
      const taskCell = row.createEl('td');
      if (ds.tasksTotal > 0) {
        const pct = Math.round((ds.tasksDone / ds.tasksTotal) * 100);
        taskCell.createEl('span', { text: `${ds.tasksDone}/${ds.tasksTotal}`, cls: `planner-hub-week-val ${pct === 100 ? 'val-good' : pct > 0 ? 'val-mid' : 'val-none'}` });
      } else {
        taskCell.createEl('span', { text: '—', cls: 'planner-hub-week-val val-none' });
      }

      // Habits
      const habitCell = row.createEl('td');
      if (ds.habitsTotal > 0) {
        const pct = Math.round((ds.habitsDone / ds.habitsTotal) * 100);
        habitCell.createEl('span', { text: `${ds.habitsDone}/${ds.habitsTotal}`, cls: `planner-hub-week-val ${pct === 100 ? 'val-good' : pct > 0 ? 'val-mid' : 'val-none'}` });
      } else {
        habitCell.createEl('span', { text: '—', cls: 'planner-hub-week-val val-none' });
      }

      // Income
      const incCell = row.createEl('td');
      incCell.createEl('span', { text: ds.income > 0 ? ds.income.toLocaleString() : '—', cls: `planner-hub-week-val ${ds.income > 0 ? 'val-income' : 'val-none'}` });

      // Expenses
      const expCell = row.createEl('td');
      expCell.createEl('span', { text: ds.expenses > 0 ? ds.expenses.toLocaleString() : '—', cls: `planner-hub-week-val ${ds.expenses > 0 ? 'val-expense' : 'val-none'}` });

      // Balance
      const balCell = row.createEl('td');
      if (ds.income > 0 || ds.expenses > 0) {
        balCell.createEl('span', {
          text: balance.toLocaleString(),
          cls: `planner-hub-week-val ${balance >= 0 ? 'val-good' : 'val-bad'}`,
        });
      } else {
        balCell.createEl('span', { text: '—', cls: 'planner-hub-week-val val-none' });
      }
    }

    // Week totals row
    const weekBalance = weekIncome - weekExpenses;
    const tfoot = table.createEl('tfoot');
    const totalRow = tfoot.createEl('tr', { cls: 'planner-hub-week-total' });
    totalRow.createEl('td', { text: isRu ? 'Итого' : 'Total', cls: 'planner-hub-week-day' });
    const weekTasksTd = totalRow.createEl('td');
    if (weekTasks > 0) {
      weekTasksTd.createEl('span', { text: `${weekTasksDone}/${weekTasks}`, cls: 'planner-hub-week-val val-total' });
    } else {
      weekTasksTd.setText('—');
    }
    const weekHabitsTd = totalRow.createEl('td');
    if (weekHabits > 0) {
      weekHabitsTd.createEl('span', { text: `${weekHabitsDone}/${weekHabits}`, cls: 'planner-hub-week-val val-total' });
    } else {
      weekHabitsTd.setText('—');
    }
    totalRow.createEl('td').createEl('span', { text: weekIncome > 0 ? weekIncome.toLocaleString() : '—', cls: `planner-hub-week-val ${weekIncome > 0 ? 'val-income' : 'val-none'}` });
    totalRow.createEl('td').createEl('span', { text: weekExpenses > 0 ? weekExpenses.toLocaleString() : '—', cls: `planner-hub-week-val ${weekExpenses > 0 ? 'val-expense' : 'val-none'}` });
    totalRow.createEl('td').createEl('span', {
      text: (weekIncome > 0 || weekExpenses > 0) ? weekBalance.toLocaleString() : '—',
      cls: `planner-hub-week-val ${weekBalance >= 0 ? 'val-good' : 'val-bad'}`,
    });

    // Today quick summary below table
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayData = this.dayCache[todayStr];
    if (todayData && todayData.hasPlan) {
      const todaySec = widget.createDiv({ cls: 'planner-hub-today-quick' });
      const dayNames = tArray('days.full');
      todaySec.createEl('h4', {
        text: `📅 ${dayNames[now.getDay()]}, ${now.getDate()} ${tArray('months.full')[now.getMonth()]}`,
      });

      // Task list (compact)
      if (todayData.tasks.length > 0) {
        const list = todaySec.createDiv({ cls: 'planner-hub-task-list' });
        for (const task of todayData.tasks.slice(0, 6)) {
          const row = list.createDiv({ cls: `planner-hub-task-row ${task.done ? 'is-done' : ''}` });
          row.createEl('span', { text: task.done ? '☑' : '☐', cls: 'planner-hub-task-check' });
          row.createEl('span', { text: task.task, cls: 'planner-hub-task-text' });
        }
        if (todayData.tasks.length > 6) {
          todaySec.createEl('span', { text: `+${todayData.tasks.length - 6} ${isRu ? 'ещё' : 'more'}`, cls: 'planner-hub-more' });
        }
      }

      // Habits compact
      if (todayData.habits.length > 0) {
        const habitsRow = todaySec.createDiv({ cls: 'planner-hub-habits' });
        for (const h of todayData.habits) {
          habitsRow.createEl('span', {
            text: `${h.done ? '✅' : '⬜'} ${h.habit}`,
            cls: `planner-hub-habit-tag ${h.done ? 'is-done' : ''}`,
          });
        }
      }
    }
  }

  // ── Board cards ──

  private renderBoardCards(parent: HTMLElement, isRu: boolean) {
    const section = parent.createDiv({ cls: 'planner-hub-section' });
    section.createEl('h3', { text: `📋 ${isRu ? 'Доски' : 'Boards'}` });

    if (this.visibleBoards.length === 0) {
      section.createEl('p', {
        text: isRu ? 'Нет досок. Создайте через контекстное меню папки.' : 'No boards. Create via folder context menu.',
        cls: 'planner-hub-empty',
      });
      return;
    }

    const grid = section.createDiv({ cls: 'planner-hub-board-grid' });
    for (const board of this.visibleBoards) {
      const card = grid.createDiv({ cls: 'planner-hub-board-card' });
      card.createEl('h4', { text: `📋 ${board.file.basename}` });
      const meta = card.createDiv({ cls: 'planner-hub-board-meta' });
      meta.createEl('span', { text: `📁 ${board.folder}` });
      meta.createEl('span', { text: `📄 ${board.plannerCount}` });

      const modes = card.createDiv({ cls: 'planner-hub-board-modes' });
      modes.createEl('span', { text: '📅', title: isRu ? 'Планер' : 'Planner' });
      modes.createEl('span', { text: '💰', title: isRu ? 'Финансы' : 'Finance' });
      modes.createEl('span', { text: '🎯', title: isRu ? 'Цели' : 'Goals' });
      modes.createEl('span', { text: '🚀', title: isRu ? 'Проекты' : 'Projects' });
      modes.createEl('span', { text: '📖', title: isRu ? 'Чтение' : 'Reading' });

      card.addEventListener('click', () => {
        const leaf = this.app.workspace.getLeaf('tab');
        void leaf.openFile(board.file);
      });
    }
  }

  // ── Helpers ──

  private renderEventList(container: HTMLElement, events: CalendarEvent[]) {
    for (const ev of events) {
      const item = container.createDiv({ cls: 'planner-hub-event' });
      item.style.setProperty('--event-color', ev.color);
      const time = ev.allDay ? (t('ui.allDay') || '🕐') :
        `${String(ev.start.getHours()).padStart(2, '0')}:${String(ev.start.getMinutes()).padStart(2, '0')}`;
      item.createEl('span', { text: time, cls: 'planner-hub-event-time' });
      item.createEl('span', { text: ev.summary, cls: 'planner-hub-event-title' });
    }
  }

  private getMondayOfWeek(date: Date): Date {
    const d = new Date(date);
    const dayOfWeek = d.getDay();
    const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  onClose() {
    this.contentContainer?.empty();
  }
}
