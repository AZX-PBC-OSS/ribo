// The on-device System One harness: `onnx-community/kev-0.6b-ONNX` behind the same `ask()` the
// hosted probes in ../0008-typesafe-jev/env.mjs use, so the re-runs there are copies and the
// comparison is honest.
//
// Three things this file does that the model card's snippet does not, each of which silently
// corrupts every probability if skipped:
//
// 1. **Delimiter ids come from `config.json`, not from encoding their names.** The card's snippet
//    applies its own caller-text escape (`<|name|>` -> `<¦name¦>`) to the delimiter names before
//    looking them up, so all five tokenize as ordinary text and collapse to the id of `<`. The
//    packing still runs and every question returns exactly uniform.
//
// 2. **The calibration temperature is applied here, because it is NOT in the graph.** kev stores a
//    per-checkpoint temperature fitted on its in-distribution dev set and the pointer head applies
//    it at load; the ONNX export's final scale is exactly 1/sqrt(head_dim) = 0.0625, i.e. T=1. So
//    the export emits raw logits and a bare softmax over them is overconfident. kev-0.6b's fitted
//    T is in `result.json` on the original repo. With it, published ECE is 0.032 in-distribution
//    and 0.073 on transfer; without it those numbers describe a different file.
//
// 3. **`confidence` is kev's own chance-corrected formula**, `(max(p) - 1/K) / (1 - 1/K)`, from
//    `kev/api.py:choice_confidence` — not max(p). A confidence gate copied from a hosted probe
//    means nothing unless the quantity is the same one.
//
// Temperature is monotone, so it moves no argmax and changes no ranking: accuracy and the
// precision/recall CURVES are identical with or without it, and only the numeric thresholds and
// the calibration move. That is why `temperature` is settable — a probe can report both.
import { AutoTokenizer, PreTrainedModel, Tensor } from "@huggingface/transformers";

export const REPO = "onnx-community/kev-0.6b-ONNX";

/** Fitted on kev-0.6b's in-distribution dev set; `result.json` `temperature` in the source repo. */
export const KEV_06B_TEMPERATURE = 1.9318726578496908;

const softmax = (xs) => {
  const m = Math.max(...xs);
  const e = xs.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
};

/** kev/api.py `choice_confidence`: max probability, rescaled so uniform reads 0 and certainty 1. */
const choiceConfidence = (p) =>
  p.length === 1 ? 1 : (Math.max(...p) - 1 / p.length) / (1 - 1 / p.length);

export async function loadKev({
  dtype = "q4",
  device = "cpu",
  temperature = KEV_06B_TEMPERATURE,
} = {}) {
  const tokenizer = await AutoTokenizer.from_pretrained(REPO);
  const model = await PreTrainedModel.from_pretrained(REPO, { dtype, device });

  const kev = model.config.kev;
  const D = kev.delimiter_ids;
  if (new Set(Object.values(D)).size !== 5) throw new Error("delimiter ids collide");

  // Caller text can never forge a delimiter (kev.user_text_escape).
  const enc = (t) =>
    Array.from(
      tokenizer(String(t).replace(/<\|([A-Za-z0-9_]+)\|>/g, "<¦$1¦>"), {
        add_special_tokens: false,
      }).input_ids.data,
      Number,
    );

  /** A question's option labels, in the order the pointer head will score them. */
  const optionsOf = (q) => {
    if (q.type === "noul") return { names: kev.noul_options, texts: kev.noul_options };
    const entries = Object.entries(q.criteria);
    return {
      names: entries.map(([name]) => name),
      // "Option descriptions render as `name: description`" — model card.
      texts: entries.map(([name, desc]) => (desc ? `${name}: ${desc}` : name)),
    };
  };

  /**
   * One forward pass over `state` plus every question in `questions`.
   *
   * Questions packed together get the probabilities they would get alone — the block-causal mask
   * isolates each branch to the state and itself (model card: measured max delta 4e-6). So
   * batching here is a latency choice, never an accuracy one.
   */
  const askOnce = async (state, questions) => {
    const ids = Object.keys(questions);
    const tokens = [D.state, ...enc(state)];
    const positions = [];

    for (const id of ids) {
      const q = questions[id];
      const { names, texts } = optionsOf(q);
      const instr = enc(q.instructions);
      const spans = texts.map((t) => [D.option_start, ...enc(t), D.option_end]);
      const base = tokens.length;
      let cursor = 1 + instr.length; // past the question delimiter and the instruction
      const ends = spans.map((s) => {
        cursor += s.length;
        return base + cursor - 1; // the option_end token closing this span
      });
      tokens.push(D.question, ...instr, ...spans.flat(), D.decide);
      positions.push({ id, names, ends, type: q.type });
    }

    // Guard the index arithmetic: every recorded position must hold an option_end. An off-by-one
    // reads a neighbouring token's pointer score and still yields a plausible distribution.
    for (const p of positions) {
      for (const i of p.ends) {
        if (tokens[i] !== D.option_end) {
          throw new Error(`${p.id}: position ${i} holds ${tokens[i]}, expected ${D.option_end}`);
        }
      }
    }

    const t0 = Date.now();
    const { logits } = await model({
      input_ids: new Tensor("int64", BigInt64Array.from(tokens, BigInt), [1, tokens.length]),
      attention_mask: new Tensor("int64", new BigInt64Array(tokens.length).fill(1n), [
        1,
        tokens.length,
      ]),
    });
    const ms = Date.now() - t0;
    const scores = Array.from(logits.to("float32").data);

    const answers = {};
    for (const p of positions) {
      const probs = softmax(p.ends.map((i) => scores[i] / temperature));
      if (p.type === "noul") {
        answers[p.id] = { type: "noul", noul: probs[1] }; // noul_options is ["no", "yes"]
      } else {
        const best = probs.indexOf(Math.max(...probs));
        answers[p.id] = {
          type: "choice",
          choice: p.names[best],
          probabilities: Object.fromEntries(p.names.map((n, i) => [n, probs[i]])),
          confidence: choiceConfidence(probs),
        };
      }
    }
    return { answers, ms, tokens: tokens.length };
  };

  return {
    limits: kev,
    /**
     * Same shape as ../0008-typesafe-jev/env.mjs `ask`, so a hosted probe becomes an on-device one
     * by swapping the import. `chunk` splits into several forward passes; the answers are
     * unaffected (see `askOnce`), only the cost is.
     */
    ask: async ({ state, questions, chunk = Infinity }) => {
      const ids = Object.keys(questions);
      const answers = {};
      let ms = 0;
      let maxTokens = 0;
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = Object.fromEntries(ids.slice(i, i + chunk).map((k) => [k, questions[k]]));
        const res = await askOnce(state, slice);
        Object.assign(answers, res.answers);
        ms += res.ms;
        maxTokens = Math.max(maxTokens, res.tokens);
      }
      return { answers, ms, tokens: maxTokens };
    },
  };
}
