import { describe, it, expect } from 'vitest';
import { parseSchema } from '../../src/parser/schema-parser';

describe('parseSchema — valid YAML', () => {
  it('parses basic schema with columns and data', () => {
    const yaml = `
type: grid
title: Test
columns:
  - id: name
    label: Name
    type: text
  - id: age
    label: Age
    type: number
data:
  - name: Alice
    age: 30
  - name: Bob
    age: 25
`;
    const schema = parseSchema(yaml);
    expect(schema.type).toBe('grid');
    expect(schema.title).toBe('Test');
    expect(schema.columns).toHaveLength(2);
    expect(schema.columns[0].id).toBe('name');
    expect(schema.columns[0].type).toBe('text');
    expect(schema.columns[1].id).toBe('age');
    expect(schema.columns[1].type).toBe('number');
    expect(schema.data).toHaveLength(2);
    expect(schema.data[0].name).toBe('Alice');
    expect(schema.data[1].age).toBe(25);
  });

  it('defaults type to grid', () => {
    const schema = parseSchema('title: Test');
    expect(schema.type).toBe('grid');
  });

  it('defaults theme to soft', () => {
    const schema = parseSchema('title: Test');
    expect(schema.theme).toBe('soft');
  });

  it('defaults locale to ru', () => {
    const schema = parseSchema('title: Test');
    expect(schema.locale).toBe('ru');
  });
});

describe('parseSchema — empty data', () => {
  it('handles missing data array', () => {
    const yaml = `
type: grid
columns:
  - id: name
    type: text
`;
    const schema = parseSchema(yaml);
    expect(schema.data).toEqual([]);
    expect(schema.columns).toHaveLength(1);
  });

  it('handles missing columns array', () => {
    const yaml = `type: grid`;
    const schema = parseSchema(yaml);
    expect(schema.columns).toEqual([]);
    expect(schema.data).toEqual([]);
  });
});

describe('parseSchema — invalid YAML', () => {
  it('throws on non-object YAML', () => {
    expect(() => parseSchema('just a string')).toThrow('Invalid planner YAML');
  });

  it('throws on null YAML', () => {
    expect(() => parseSchema('')).toThrow();
  });
});

describe('parseSchema — template field', () => {
  it('preserves template field', () => {
    const yaml = `
template: daily-planner
day: "2024-01-15"
`;
    const schema = parseSchema(yaml);
    expect(schema.template).toBe('daily-planner');
    expect(schema['day']).toBe('2024-01-15');
  });
});

describe('parseSchema — column features', () => {
  it('parses frozen columns', () => {
    const yaml = `
columns:
  - id: name
    type: text
    frozen: true
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].frozen).toBe(true);
  });

  it('parses select options', () => {
    const yaml = `
columns:
  - id: status
    type: select
    options:
      - open
      - closed
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].options).toEqual(['open', 'closed']);
  });

  it('parses min/max for number', () => {
    const yaml = `
columns:
  - id: progress
    type: number
    min: 0
    max: 100
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].min).toBe(0);
    expect(schema.columns[0].max).toBe(100);
  });

  it('parses formula column', () => {
    const yaml = `
columns:
  - id: total
    type: formula
    formula: "a + b"
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].formula).toBe('a + b');
  });

  it('parses color_scale', () => {
    const yaml = `
columns:
  - id: score
    type: number
    color_scale:
      0: "#ff0000"
      100: "#00ff00"
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].color_scale).toEqual({ 0: '#ff0000', 100: '#00ff00' });
  });

  it('parses highlight_if', () => {
    const yaml = `
columns:
  - id: val
    type: number
    highlight_if: "> 50"
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].highlight_if).toBe('> 50');
  });

  it('parses group', () => {
    const yaml = `
columns:
  - id: a
    type: text
    group: basics
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].group).toBe('basics');
  });

  it('defaults label to id', () => {
    const yaml = `
columns:
  - id: myfield
    type: text
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].label).toBe('myfield');
  });

  it('defaults type to text', () => {
    const yaml = `
columns:
  - id: myfield
`;
    const schema = parseSchema(yaml);
    expect(schema.columns[0].type).toBe('text');
  });
});

describe('parseSchema — summary', () => {
  it('parses summary definitions', () => {
    const yaml = `
columns:
  - id: score
    type: number
summary:
  - column: score
    formula: "AVG(score)"
    label: Average
`;
    const schema = parseSchema(yaml);
    expect(schema.summary).toHaveLength(1);
    expect(schema.summary![0].column).toBe('score');
    expect(schema.summary![0].formula).toBe('AVG(score)');
    expect(schema.summary![0].label).toBe('Average');
  });
});

describe('parseSchema — extra fields passthrough', () => {
  it('passes through template-specific fields', () => {
    const yaml = `
template: goal-tracker
year: 2024
goals:
  - objective: Ship v2
`;
    const schema = parseSchema(yaml);
    expect(schema['year']).toBe(2024);
    expect(schema['goals']).toEqual([{ objective: 'Ship v2' }]);
  });
});
