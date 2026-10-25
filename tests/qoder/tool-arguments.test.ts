import test from 'node:test'
import assert from 'node:assert/strict'
import { repairToolCallArguments } from '../../src/qoder/transport/wire/tool-arguments.ts'

/** Strip the backslashes from one value's quotes, the way a model pastes quoted prose. */
function unescapeQuotesOf(json: string, value: string): string {
  const encoded = JSON.stringify(value).slice(1, -1)
  return json.replace(encoded, value)
}

test('repairToolCallArguments returns strict JSON unchanged and reports no repair', () => {
  const documents = [
    '{}',
    '{"a":1}',
    '{"a":"b","c":[1,2,{"d":null}],"e":true}',
    '  {"a":"\\"already escaped\\"","b":"line\\nbreak"}  ',
    '{"中文键":"中文值","emoji":"😀"}',
  ]
  for (const document of documents) {
    const result = repairToolCallArguments(document)
    assert.deepEqual(result.repairs, [], document)
    assert.deepEqual(result.arguments, JSON.parse(document) as unknown, document)
  }
})

test('repairToolCallArguments restores prose quotes from the turn that failed', () => {
  // Recorded from the Qoder turn of 2026-10-21 20:26: the model asked three questions and
  // pasted quoted prose (`少了"两个人在两个世界"的实感`, `但"终端感"会打折`) without escaping
  // it, so the completed call was rejected and the turn produced nothing.
  const recorded = '{"questions": [{"id": "location", "header": "写在哪", "question": "sandbox 只允许我写 D:\\\\Deepseek WorkSpace，那个目录我刚试过，建个空文件夹都被拒（PermissionError）。所以：", "options": [{"label": "在工作区新建一份独立副本（推荐）", "description": "原项目一个字节不动，新目录自带服务，数据从原路径读。跑起来是两个互不干扰的东西，你随时能对比、能回退。"}, {"label": "直接改进原项目", "description": "保持连续性，路径不变。但我需要你批准我写 C:\\\\Users\\\\86139\\\\WorkBuddy\\\\...\\\\character-voice，且改动没有回退余地（那个目录不是 git 仓库）。"}]}, {"id": "worlds", "header": "两个世界", "question": "双频道这块，你要哪种关系？", "options": [{"label": "两个独立频道，互不知情（推荐）", "description": "CH-A 终端版和 CH-B 女高中生版各自独立记忆。最贴原作设定，也最有戏——你知道另一边的存在，她不知道。"}, {"label": "单频道，两边偶尔串线", "description": "只有一个长门，但界面上会偶尔闪过另一个世界的碎片（乱码、残句）。更神秘，但少了"两个人在两个世界"的实感。"}, {"label": "双频道 + 可开的串线开关", "description": "默认两个独立频道，另给一个隐藏开关，打开后低频出现跨世界碎片。做起来最费，但两个都要。"}]}, {"id": "purity", "header": "终端纯度", "question": "界面走多纯的终端？", "options": [{"label": "纯日志：全等宽、行号、无气泡（推荐）", "description": "视觉最统一，最像真的终端。中文等宽字体读长段落稍吃力，但她本来就很少说长句。"}, {"label": "混合：终端外壳 + 衬线正文", "description": "行号/时间码用等宽，正文用衬线（现在 index.html 就是这么干的）。长段落更好读，但"终端感"会打折。"}]}]}'

  const result = repairToolCallArguments(recorded)
  assert.deepEqual(result.repairs, ['unescaped quotes'])

  const questions = result.arguments.questions as Array<{
    id: string
    header: string
    question: string
    options: Array<{ label: string; description: string }>
  }>
  assert.deepEqual(questions.map(question => question.id), ['location', 'worlds', 'purity'])
  assert.deepEqual(questions.map(question => question.header), ['写在哪', '两个世界', '终端纯度'])
  assert.deepEqual(questions.map(question => question.options.length), [2, 3, 2])
  assert.equal(
    questions[1]?.options[1]?.description,
    '只有一个长门，但界面上会偶尔闪过另一个世界的碎片（乱码、残句）。更神秘，但少了"两个人在两个世界"的实感。',
  )
  assert.equal(
    questions[2]?.options[1]?.description,
    '行号/时间码用等宽，正文用衬线（现在 index.html 就是这么干的）。长段落更好读，但"终端感"会打折。',
  )
})

test('repairToolCallArguments treats a quote as structural only before a delimiter', () => {
  // A quote is prose unless a JSON delimiter follows it, which is what well-written
  // documents always have at their closing quotes.
  const cases: Array<[string, Record<string, unknown>]> = [
    ['{"a":"x"y"}', { a: 'x"y' }],
    ['{"a":"但少了"两个世界"的实感。"}', { a: '但少了"两个世界"的实感。' }],
    ['{"a":"他说"好"，又说"不好""}', { a: '他说"好"，又说"不好"' }],
    ['{"a":"前"x"后","b":"另一"y"值"}', { a: '前"x"后', b: '另一"y"值' }],
    ['{"a":"他说" 好 "。","b":1}', { a: '他说" 好 "。', b: 1 }],
    ['{"a":"x"y"}', { a: 'x"y' }],
  ]
  for (const [text, expected] of cases) {
    const result = repairToolCallArguments(text)
    assert.deepEqual(result.repairs, ['unescaped quotes'], text)
    assert.equal(JSON.stringify(result.arguments), JSON.stringify(expected), text)
  }
})

test('repairToolCallArguments completes a truncated response without inventing content', () => {
  assert.deepEqual(repairToolCallArguments('{"a":"abc').arguments, { a: 'abc' })
  assert.deepEqual(repairToolCallArguments('{"a":[1,2').arguments, { a: [1, 2] })
  assert.deepEqual(repairToolCallArguments('{"a":{"b":1').arguments, { a: { b: 1 } })
  assert.deepEqual(repairToolCallArguments('{"a":[{"b":"c"}').arguments, { a: [{ b: 'c' }] })
  // A member the model never finished is dropped rather than guessed at.
  assert.deepEqual(repairToolCallArguments('{"a":1,"b').arguments, { a: 1 })
  assert.deepEqual(repairToolCallArguments('{"a":1,"b":2').arguments, { a: 1 })
  assert.deepEqual(repairToolCallArguments('{"a":1,').arguments, { a: 1 })
})

test('repairToolCallArguments combines quote repair with truncation', () => {
  const result = repairToolCallArguments('{"a":"前"x"后')
  assert.deepEqual(result.repairs, ['unescaped quotes', 'truncated JSON'])
  assert.deepEqual(result.arguments, { a: '前"x"后' })
})

test('repairToolCallArguments refuses text that is not repairable JSON', () => {
  for (const text of ['', '   ', '{', '[]', '"x"', '12', 'null', '{"a": }', '{"a":,}', '{a:1}', '{"a":1}}']) {
    assert.throws(() => repairToolCallArguments(text), SyntaxError, text)
  }
})

test('repairToolCallArguments never alters valid JSON and recovers generated prose quotes', () => {
  let seed = 20261021
  const random = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T
  const noise = ['a', '中', '文', '好', '"', '\\', ' ', '，', '。', '{', '}', '[', ']', ',', ':', '\n', '😀', '/']

  const generate = (depth: number): unknown => {
    const kind = depth > 2 ? Math.floor(random() * 3) : Math.floor(random() * 5)
    if (kind === 0) return null
    if (kind === 1) return Math.floor(random() * 1000)
    if (kind === 2) return Array.from({ length: Math.floor(random() * 5) }, () => pick(noise)).join('')
    if (kind === 3) return random() < 0.5
    const object: Record<string, unknown> = {}
    for (let index = 0; index < Math.floor(random() * 4); index += 1) object[`k${index}`] = generate(depth + 1)
    return object
  }

  // Valid JSON must survive untouched: a repair that fires here would corrupt real traffic.
  for (let trial = 0; trial < 5000; trial += 1) {
    const object: Record<string, unknown> = {}
    for (let index = 0; index < 1 + Math.floor(random() * 3); index += 1) object[`k${index}`] = generate(0)
    const text = random() < 0.5 ? JSON.stringify(object) : JSON.stringify(object, null, Math.floor(random() * 3))
    const result = repairToolCallArguments(text)
    assert.deepEqual(result.repairs, [], text)
    assert.equal(JSON.stringify(result.arguments), JSON.stringify(JSON.parse(text)), text)
  }

  // A value whose quotes lost their escapes must come back byte-identical in meaning.
  let restored = 0
  for (let trial = 0; trial < 2000; trial += 1) {
    const word = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(['a', '中', '好', '文', ' ', '，', '。'])).join('')
    const value = `${pick(['前', '他说', ''])}"${word}"${pick(['后', '。', ''])}`
    const object = { questions: [{ id: 'q', question: value, header: 'hdr', options: [{ label: word }] }] }
    const json = JSON.stringify(object)
    const broken = unescapeQuotesOf(json, value)
    if (broken === json) continue
    assert.equal(JSON.stringify(repairToolCallArguments(broken).arguments), JSON.stringify(object), broken)
    restored += 1
  }
  assert.ok(restored > 1500, `only ${restored} prose-quote cases exercised`)
})
