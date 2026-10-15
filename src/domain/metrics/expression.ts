import { ValidationError } from '../../shared/errors';
import { DataPoint, TimeSeries } from './time-series';

/**
 * Wyrażenie "Math" jak w Grafanie (Server Side Expressions): $A / $B * 100, ($A - $B) / 1024, ${A} + 5.
 * Obsługiwane: liczby, odwołania do zapytań ($A, ${A}), + - * /, nawiasy, minus jednoargumentowy.
 * Liczone punkt po punkcie dla wspólnych chwil serii (jak w Grafanie); dzielenie przez 0 pomija punkt.
 */
type Node =
    | { kind: 'num'; value: number }
    | { kind: 'ref'; refId: string }
    | { kind: 'neg'; arg: Node }
    | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Node; right: Node };

const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|\$\{(\w+)\}|\$(\w+)|([-+*/()]))/iy;

function parse(expression: string): Node {
    const tokens: { num?: number; ref?: string; op?: string }[] = [];
    TOKEN.lastIndex = 0;
    let pos = 0;
    while (pos < expression.length) {
        if (/^\s*$/.test(expression.slice(pos))) break;
        TOKEN.lastIndex = pos;
        const m = TOKEN.exec(expression);
        if (!m) throw new ValidationError(`Wyrażenie "${expression}": niezrozumiały fragment "${expression.slice(pos).trim()}"`);
        if (m[1] !== undefined) tokens.push({ num: Number(m[1]) });
        else if (m[2] ?? m[3]) tokens.push({ ref: (m[2] ?? m[3])! });
        else tokens.push({ op: m[4] });
        pos = TOKEN.lastIndex;
    }

    let i = 0;
    const peek = () => tokens[i];
    const expect = (op: string) => {
        if (peek()?.op !== op) throw new ValidationError(`Wyrażenie "${expression}": oczekiwano "${op}"`);
        i++;
    };
    const primary = (): Node => {
        const t = tokens[i++];
        if (!t) throw new ValidationError(`Wyrażenie "${expression}": niepełne wyrażenie`);
        if (t.num !== undefined) return { kind: 'num', value: t.num };
        if (t.ref) return { kind: 'ref', refId: t.ref };
        if (t.op === '-') return { kind: 'neg', arg: primary() };
        if (t.op === '+') return primary();
        if (t.op === '(') {
            const inner = sum();
            expect(')');
            return inner;
        }
        throw new ValidationError(`Wyrażenie "${expression}": nieoczekiwany "${t.op}"`);
    };
    const product = (): Node => {
        let node = primary();
        while (peek()?.op === '*' || peek()?.op === '/') {
            const op = tokens[i++].op as '*' | '/';
            node = { kind: 'bin', op, left: node, right: primary() };
        }
        return node;
    };
    const sum = (): Node => {
        let node = product();
        while (peek()?.op === '+' || peek()?.op === '-') {
            const op = tokens[i++].op as '+' | '-';
            node = { kind: 'bin', op, left: node, right: product() };
        }
        return node;
    };

    const tree = sum();
    if (i < tokens.length) throw new ValidationError(`Wyrażenie "${expression}": nadmiarowy fragment`);
    return tree;
}

function refsOf(node: Node, acc = new Set<string>()): Set<string> {
    if (node.kind === 'ref') acc.add(node.refId);
    else if (node.kind === 'neg') refsOf(node.arg, acc);
    else if (node.kind === 'bin') { refsOf(node.left, acc); refsOf(node.right, acc); }
    return acc;
}

function evaluate(node: Node, vars: Record<string, number>): number {
    switch (node.kind) {
        case 'num': return node.value;
        case 'ref': return vars[node.refId];
        case 'neg': return -evaluate(node.arg, vars);
        case 'bin': {
            const a = evaluate(node.left, vars);
            const b = evaluate(node.right, vars);
            return node.op === '+' ? a + b : node.op === '-' ? a - b : node.op === '*' ? a * b : a / b;
        }
    }
}

export class MathExpression {
    private readonly tree: Node;
    readonly refs: string[];

    constructor(readonly expression: string) {
        this.tree = parse(expression);
        this.refs = [...refsOf(this.tree)];
        if (this.refs.length === 0) throw new ValidationError(`Wyrażenie "${expression}" nie odwołuje się do żadnego zapytania ($A, $B...)`);
    }

    /**
     * Wynik dla serii zapytań (refId -> serie). Gdy zapytanie zwraca kilka serii (GROUP BY tag), łączone są serie
     * o tych samych tagach; zapytanie z jedną serią pasuje do każdej. Zwraca serie z tagami serii źródłowych.
     */
    public apply(series: ReadonlyMap<string, readonly TimeSeries[]>): TimeSeries[] {
        for (const ref of this.refs) {
            if (!series.has(ref)) throw new ValidationError(`Wyrażenie "${this.expression}": brak zapytania ${ref}`);
        }
        const keyOf = (ts: TimeSeries) => JSON.stringify(Object.entries(ts.tags).sort());
        // zestawy tagów z zapytań wielu serii; bez nich - jedna kombinacja
        const multi = this.refs.filter(r => series.get(r)!.length > 1);
        const tagSets = multi.length ? [...new Map(series.get(multi[0])!.map(ts => [keyOf(ts), ts.tags])).values()] : [{}];

        const result: TimeSeries[] = [];
        for (const tags of tagSets) {
            const key = JSON.stringify(Object.entries(tags).sort());
            const inputs = this.refs.map(ref => {
                const list = series.get(ref)!;
                return list.length === 1 ? list[0] : list.find(ts => keyOf(ts) === key);
            });
            if (inputs.some(ts => !ts || ts.isEmpty)) continue;

            const byTime = inputs.map(ts => new Map(ts!.points.map(p => [p.timestamp, p.value])));
            const points: DataPoint[] = [];
            for (const { timestamp } of inputs[0]!.points) {
                const vars: Record<string, number> = {};
                let complete = true;
                this.refs.forEach((ref, i) => {
                    const v = byTime[i].get(timestamp);
                    if (v === undefined) complete = false;
                    else vars[ref] = v;
                });
                if (!complete) continue;
                const value = evaluate(this.tree, vars);
                if (Number.isFinite(value)) points.push({ timestamp, value });
            }
            result.push(new TimeSeries('math', tags, points));
        }
        return result;
    }
}
