import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: "export {OfficeState} from './webview-ui/src/office/engine/officeState.ts'; export {getCharacterSprite} from './webview-ui/src/office/engine/characters.ts'; export {getCharacterSprites} from './webview-ui/src/office/sprites/spriteData.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
  platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { OfficeState, getCharacterSprite, getCharacterSprites } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const office = new OfficeState();
assert.equal(office.availableComputerDesks(), 12);
for (let id = 1; id <= 6; id++) {
  const reservationId = 100 + id;
  const seat = office.reserveComputerDesk(reservationId);
  assert(seat);
  office.addAgent(id, id % 6, 0, undefined, true, true, reservationId);
  const character = office.characters.get(id);
  assert.equal(character.seatId, seat, 'Creation must consume its reserved desk.');
  assert(office.seats.get(seat).computerDeskId);
  office.setOfficeLabel(id, { name: `Worker ${id}`, status: 'idle', needsInput: false, managed: true });
  office.setAgentActive(id, false);
}
const positions = [...office.characters.values()].map(character => ({ id: character.id, seatId: character.seatId,
  col: character.tileCol, row: character.tileRow, x: character.x, y: character.y }));
for (let frame = 0; frame < 3600; frame++) office.update(0.1);
assert.deepEqual([...office.characters.values()].map(character => ({ id: character.id, seatId: character.seatId,
  col: character.tileCol, row: character.tileRow, x: character.x, y: character.y })), positions);
assert([...office.characters.values()].every(character => character.state === 'type'));
for (const character of office.characters.values()) {
  const seat = office.seats.get(character.seatId);
  assert.equal(character.dir, seat.facingDir, 'The seated worker must face its computer desk.');
  assert.equal(character.frame, 0, 'Idle must use the static typing frame.');
  const sprites = getCharacterSprites(character.palette, character.hueShift);
  assert.equal(getCharacterSprite(character, sprites), sprites.typing[seat.facingDir][0], 'Idle must render the seated typing sprite, never a walking/standing sprite.');
}
console.log('PASS: six managed idle workers keep the seated typing sprite facing distinct computer desks for six simulated minutes.');

office.setOfficeLabel(1, { name: 'Worker 1', status: 'needs input', needsInput: true, managed: true });
for (let frame = 0; frame < 600; frame++) office.update(0.1);
assert.equal(office.characters.get(1).state, 'type');
assert.equal(office.characters.get(1).seatId, positions[0].seatId);
const child = office.addSubagent(1, 'child');
assert(child !== null);
assert(office.seats.get(office.characters.get(child).seatId).computerDeskId);
assert.equal(office.characters.get(child).officeLabel.name, 'Worker 1');
console.log('PASS: input waits remain seated, and a child inherits its worker name and claims a spare computer desk.');

const reservations = [];
for (let id = 200; office.availableComputerDesks() > 0; id++) reservations.push(id), assert(office.reserveComputerDesk(id));
assert.equal(office.reserveComputerDesk(999), null);
assert.equal(office.addSubagent(1, 'no-free-desk'), null);
assert.equal(office.characters.size, 7, 'A child without a desk must not appear as an unseated character.');
office.releaseComputerDesk(reservations[0]);
assert.equal(office.availableComputerDesks(), 1);
console.log('PASS: reservations prevent desk races; capacity exhaustion creates no unseated child and release restores availability.');

const custom = new OfficeState({ ...office.getLayout(), furniture: office.getLayout().furniture.filter(item => item.type !== 'pc') });
assert.equal(custom.availableComputerDesks(), 0, 'A chair and desk without a computer cannot host a managed worker.');
assert.deepEqual(custom.getLayout().furniture, office.getLayout().furniture.filter(item => item.type !== 'pc'));
console.log('PASS: valid custom furniture is retained, and ordinary desks without computers are ineligible.');
