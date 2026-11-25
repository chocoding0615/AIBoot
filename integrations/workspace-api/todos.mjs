import crypto from 'node:crypto';
import { fail } from '../report-scheduler/core.mjs';

export class WorkspaceTodoService {
  constructor({ clock = () => new Date(), initialTodos = null, ledger = null } = {}) {
    this.clock = clock;
    this.ledger = ledger;
    this.todos = new Map();

    const defaults = initialTodos || [
      {
        id: 'todo-1',
        title: '생각공장 주차권',
        dueDate: '2026-11-26',
        dueLabel: 'D-1',
        source: 'report',
        completed: false,
        taskRef: 'fixed:parking',
        createdAt: this.clock().toISOString(),
      },
      {
        id: 'todo-2',
        title: '보험료 납부',
        dueDate: '2026-11-28',
        dueLabel: 'D-3',
        source: 'report',
        completed: false,
        taskRef: 'fixed:insurance',
        createdAt: this.clock().toISOString(),
      },
    ];

    for (const t of defaults) {
      this.todos.set(t.id, t);
    }
  }

  list() {
    return {
      items: Array.from(this.todos.values()),
    };
  }

  get(id) {
    const item = this.todos.get(id);
    if (!item) fail('NOT_FOUND', 404);
    return item;
  }

  add(body) {
    if (!body || typeof body !== 'object') fail('INVALID_REQUEST', 400);
    const { title, dueDate, note, taskRef } = body;

    if (!title || typeof title !== 'string' || !title.trim() || title.length > 100) {
      fail('INVALID_REQUEST', 400);
    }

    const id = crypto.randomUUID();
    const now = this.clock();

    const todo = {
      id,
      title: title.trim(),
      dueDate: dueDate || null,
      dueLabel: dueDate ? dueDate.slice(5) : '기한 없음',
      note: note || '',
      source: 'user',
      completed: false,
      completedAt: null,
      taskRef: taskRef || null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    this.todos.set(id, todo);
    return todo;
  }

  toggle(id, completed) {
    if (!id || !this.todos.has(id)) fail('NOT_FOUND', 404);
    const todo = this.todos.get(id);

    const isCompleted = completed !== undefined ? Boolean(completed) : !todo.completed;
    todo.completed = isCompleted;
    todo.completedAt = isCompleted ? this.clock().toISOString() : null;
    todo.updatedAt = this.clock().toISOString();

    if (isCompleted && todo.taskRef && this.ledger && typeof this.ledger.recordAction === 'function') {
      try {
        this.ledger.recordAction({
          taskRef: todo.taskRef,
          action: 'completed',
          date: todo.completedAt,
          note: `할 일 완료 처리: ${todo.title}`,
        });
      } catch (e) {
        // 원장 기록 오류가 할 일 완료 상태를 방해하지 않음
      }
    }

    return todo;
  }

  remove(id) {
    if (!id || !this.todos.has(id)) fail('NOT_FOUND', 404);
    this.todos.delete(id);
    return { removed: true, id };
  }
}
