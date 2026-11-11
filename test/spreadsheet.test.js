import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerDate, parseCsv, parseGrid } from '../server/spreadsheet.js';

test('headerDate understands common formats', () => {
  assert.equal(headerDate('05/01/2032'), '2032-01-05');
  assert.equal(headerDate('05/01/2032', { dateOrder: 'mdy' }), '2032-05-01');
  assert.equal(headerDate('Mon 5-Jan-32'), '2032-01-05');
  assert.equal(headerDate('5 January 2032'), '2032-01-05');
  assert.equal(headerDate('Jan 5, 2032'), '2032-01-05');
  assert.equal(headerDate('2032-01-05'), '2032-01-05');
  assert.equal(headerDate(new Date(Date.UTC(2032, 0, 5))), '2032-01-05');
  assert.equal(headerDate('31/02/2032'), null);
  assert.equal(headerDate('Name'), null);
});

test('parseCsv handles quotes and newlines', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\r\n1,,3'), [
    ['a', 'b,c', 'd "e"'],
    ['1', null, '3'],
  ]);
});

test('parseGrid with Team column, weekday sub-header and blank team rows as vacancies', () => {
  const rows = parseCsv(
    [
      'Staff Number,Name,Team,01/02/2030,02/02/2030',
      ',,,Fri,Sat',
      '1,A One,Alpha,T1,RD',
      ',,Alpha,,',
      '2,B Two,Bravo,AL,AL',
    ].join('\n'),
  );
  const p = parseGrid(rows);
  assert.deepEqual(p.dates, ['2030-02-01', '2030-02-02']);
  assert.deepEqual(
    p.teams.map((t) => [t.name, t.members.length, t.vacancies]),
    [
      ['Alpha', 1, 1],
      ['Bravo', 1, 0],
    ],
  );
  assert.equal(p.teams[0].members[0].initials, 'AO');
});
