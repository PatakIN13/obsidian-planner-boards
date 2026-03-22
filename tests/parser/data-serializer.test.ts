import { describe, it, expect } from 'vitest';
import { serializeSchema } from '../../src/parser/data-serializer';
import { parseSchema } from '../../src/parser/schema-parser';
import { PlannerSchema, ColumnDef } from '../../src/types';

describe('serializeSchema — basic', () => {
  it('serializes and re-parses a simple schema', () => {
    const schema: PlannerSchema = {
      type: 'grid',
      title: 'Test',
      theme: 'dark',
      locale: 'en',
      columns: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'age', label: 'Age', type: 'number' },
      ],
      data: [
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ],
    };

    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);

    expect(reparsed.type).toBe('grid');
    expect(reparsed.title).toBe('Test');
    expect(reparsed.theme).toBe('dark');
    expect(reparsed.locale).toBe('en');
    expect(reparsed.columns).toHaveLength(2);
    expect(reparsed.data).toHaveLength(2);
    expect(reparsed.data[0].name).toBe('Alice');
    expect(reparsed.data[1].age).toBe(25);
  });

  it('omits theme when it is "soft" (default)', () => {
    const schema: PlannerSchema = {
      type: 'grid',
      title: 'Test',
      theme: 'soft',
      columns: [{ id: 'a', label: 'A', type: 'text' }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    expect(yaml).not.toContain('theme:');
  });

  it('omits locale when it is "ru" (default)', () => {
    const schema: PlannerSchema = {
      type: 'grid',
      title: 'Test',
      locale: 'ru',
      columns: [{ id: 'a', label: 'A', type: 'text' }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    expect(yaml).not.toContain('locale:');
  });
});

describe('serializeSchema — template schema', () => {
  it('uses template instead of type when template is set', () => {
    const schema: PlannerSchema = {
      type: 'grid',
      template: 'daily-planner',
      title: 'My Day',
      columns: [{ id: 'a', label: 'A', type: 'text' }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    expect(yaml).toContain('template:');
    expect(yaml).not.toContain('type:');
  });

  it('omits columns and data when template is set', () => {
    const schema: PlannerSchema = {
      template: 'daily-planner',
      columns: [{ id: 'a', label: 'A', type: 'text' }],
      data: [{ a: 'hello' }],
    };
    const yaml = serializeSchema(schema);
    expect(yaml).not.toMatch(/^columns:/m);
    expect(yaml).not.toMatch(/^data:/m);
  });
});

describe('serializeSchema — column features', () => {
  it('preserves column options, min, max', () => {
    const schema: PlannerSchema = {
      columns: [{
        id: 'score', label: 'Score', type: 'number',
        min: 0, max: 100, frozen: true,
      }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);
    expect(reparsed.columns[0].min).toBe(0);
    expect(reparsed.columns[0].max).toBe(100);
    expect(reparsed.columns[0].frozen).toBe(true);
  });

  it('preserves formula and format', () => {
    const schema: PlannerSchema = {
      columns: [{
        id: 'total', label: 'Total', type: 'formula',
        formula: 'a + b', format: '0.00',
      }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);
    expect(reparsed.columns[0].formula).toBe('a + b');
    expect(reparsed.columns[0].format).toBe('0.00');
  });

  it('preserves select options', () => {
    const schema: PlannerSchema = {
      columns: [{
        id: 'status', label: 'Status', type: 'select',
        options: ['open', 'closed', 'pending'],
      }],
      data: [],
    };
    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);
    expect(reparsed.columns[0].options).toEqual(['open', 'closed', 'pending']);
  });
});

describe('serializeSchema — roundtrip', () => {
  it('roundtrip preserves data types', () => {
    const schema: PlannerSchema = {
      type: 'grid',
      title: 'Roundtrip',
      columns: [
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'score', label: 'Score', type: 'number' },
        { id: 'done', label: 'Done', type: 'checkbox' },
      ],
      data: [
        { name: 'Test', score: 42, done: true },
      ],
    };
    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);
    expect(reparsed.data[0].name).toBe('Test');
    expect(reparsed.data[0].score).toBe(42);
    expect(reparsed.data[0].done).toBe(true);
  });
});

describe('serializeSchema — summary', () => {
  it('preserves summary definitions in roundtrip', () => {
    const schema: PlannerSchema = {
      columns: [{ id: 'score', label: 'Score', type: 'number' }],
      summary: [{ column: 'score', formula: 'AVG(score)', label: 'Avg' }],
      data: [{ score: 10 }],
    };
    const yaml = serializeSchema(schema);
    const reparsed = parseSchema(yaml);
    expect(reparsed.summary).toHaveLength(1);
    expect(reparsed.summary![0].formula).toBe('AVG(score)');
  });
});

describe('serializeSchema — extra template fields', () => {
  it('passes through non-standard fields', () => {
    const schema: PlannerSchema = {
      template: 'goal-tracker',
      columns: [],
      data: [],
      year: 2024,
    };
    const yaml = serializeSchema(schema);
    expect(yaml).toContain('year:');
    const reparsed = parseSchema(yaml);
    expect(reparsed['year']).toBe(2024);
  });
});
