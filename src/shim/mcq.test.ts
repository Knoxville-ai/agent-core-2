import { describe, expect, it } from "vitest";

import {
  mcqToModelText,
  parseKnoxAsk,
  parseStoredMcq,
  SentinelFilter,
} from "./mcq.js";

const FENCE = "```knox:ask";

function block(payload: unknown): string {
  return `${FENCE}\n${JSON.stringify(payload)}\n\`\`\``;
}

/** Drive a SentinelFilter with a string pre-split into arbitrary chunks. */
function runFilter(chunks: string[]): { visible: string; filter: SentinelFilter } {
  const filter = new SentinelFilter();
  let visible = "";
  for (const c of chunks) visible += filter.push(c);
  visible += filter.flush();
  return { visible, filter };
}

describe("parseKnoxAsk", () => {
  it("parses a well-formed block into a normalized mcq", () => {
    const mcq = parseKnoxAsk(
      block({
        questions: [
          {
            header: "Backorder?",
            question: "How should I proceed?",
            options: [
              { label: "Partial + backorder", description: "ship now, backorder rest" },
              { label: "Cancel" },
            ],
          },
        ],
        allowOther: true,
      }),
    );
    expect(mcq).not.toBeNull();
    expect(mcq!.type).toBe("mcq");
    expect(mcq!.questions).toHaveLength(1);
    expect(mcq!.questions[0]!.header).toBe("Backorder?");
    expect(mcq!.questions[0]!.options).toHaveLength(2);
    expect(mcq!.allowOther).toBe(true);
    expect(mcq!.question_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("defaults allowOther to true and derives a short header when omitted", () => {
    const mcq = parseKnoxAsk(
      block({
        questions: [
          { question: "Which vendor should I use?", options: [{ label: "a" }, { label: "b" }] },
        ],
      }),
    )!;
    expect(mcq.allowOther).toBe(true);
    expect(mcq.questions[0]!.header.length).toBeGreaterThan(0);
    expect(mcq.questions[0]!.header.length).toBeLessThanOrEqual(12);
    expect(mcq.questions[0]!.multiSelect).toBe(false);
  });

  it("clamps to 4 questions and 4 options each", () => {
    const many = {
      questions: Array.from({ length: 6 }, (_, i) => ({
        question: `q${i}?`,
        options: Array.from({ length: 6 }, (_, j) => ({ label: `o${j}` })),
      })),
    };
    const mcq = parseKnoxAsk(block(many))!;
    expect(mcq.questions).toHaveLength(4);
    expect(mcq.questions[0]!.options).toHaveLength(4);
  });

  it("rejects a question with fewer than two options", () => {
    expect(
      parseKnoxAsk(block({ questions: [{ question: "q?", options: [{ label: "only" }] }] })),
    ).toBeNull();
  });

  it("returns null on malformed JSON and when no fence is present", () => {
    expect(parseKnoxAsk(`${FENCE}\n{not json}\n\`\`\``)).toBeNull();
    expect(parseKnoxAsk("just some prose, no question here")).toBeNull();
  });
});

describe("SentinelFilter", () => {
  it("passes normal text through unchanged", () => {
    const { visible, filter } = runFilter(["Hello ", "there", "!"]);
    expect(filter.sawSentinel).toBe(false);
    expect(visible).toBe("Hello there!");
  });

  it("emits pre-fence text and suppresses the fenced block", () => {
    const payload = block({
      questions: [{ question: "q?", options: [{ label: "a" }, { label: "b" }] }],
    });
    const { visible, filter } = runFilter(["Quick check:\n", payload]);
    expect(filter.sawSentinel).toBe(true);
    expect(visible).toBe("Quick check:\n");
    expect(filter.suppressedText().startsWith("```knox")).toBe(true);
    expect(parseKnoxAsk(filter.suppressedText())).not.toBeNull();
  });

  it("never leaks the fence even when streamed one character at a time", () => {
    const payload = block({
      questions: [{ question: "q?", options: [{ label: "a" }, { label: "b" }] }],
    });
    const { visible, filter } = runFilter(("lead " + payload).split(""));
    expect(filter.sawSentinel).toBe(true);
    expect(visible).toBe("lead ");
    expect(parseKnoxAsk(filter.suppressedText())).not.toBeNull();
  });

  it("holds back a partial marker suffix, then flushes it when it isn't a fence", () => {
    const { visible, filter } = runFilter(["done ", "``"]);
    expect(filter.sawSentinel).toBe(false);
    expect(visible).toBe("done ``");
  });
});

describe("parseStoredMcq / mcqToModelText", () => {
  it("round-trips a persisted payload and preserves the question_id", () => {
    const mcq = parseKnoxAsk(
      block({ questions: [{ question: "q?", options: [{ label: "a" }, { label: "b" }] }] }),
    )!;
    const back = parseStoredMcq(JSON.stringify(mcq))!;
    expect(back).not.toBeNull();
    expect(back.question_id).toBe(mcq.question_id);
    expect(back.questions[0]!.options).toHaveLength(2);
  });

  it("ignores plain text and other structured payloads", () => {
    expect(parseStoredMcq("hello")).toBeNull();
    expect(parseStoredMcq('{"type":"tool_call","tool_name":"x"}')).toBeNull();
  });

  it("renders a readable summary including options and the Other escape hatch", () => {
    const mcq = parseKnoxAsk(
      block({ questions: [{ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] }] }),
    )!;
    const text = mcqToModelText(mcq);
    expect(text).toContain("Ship it?");
    expect(text).toContain("Yes");
    expect(text).toContain("Other");
  });
});
