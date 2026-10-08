import { describe, it, expect } from "bun:test";
import { matchOption, normalizeReply, parseOptions, resolveDefault } from "../src/answer.ts";

const pick = (reply: string, options: string[]) => {
  const m = matchOption(reply, options);
  return m.kind === "match" ? options[m.index] : m.kind;
};

describe("parseOptions", () => {
  it("splits on | and trims", () => {
    expect(parseOptions(" A | B |C ")).toEqual(["A", "B", "C"]);
    expect(parseOptions("yes||no")).toEqual(["yes", "no"]);
    expect(parseOptions(undefined)).toEqual([]);
  });
});

describe("normalizeReply", () => {
  it("lowercases, folds ё, strips punctuation", () => {
    expect(normalizeReply("Ещё, Второй!")).toEqual(["еще", "второй"]);
  });
});

describe("matchOption: letters", () => {
  const abc = ["A", "B", "C"];
  it("matches a bare letter and 'option B'", () => {
    expect(pick("B", abc)).toBe("B");
    expect(pick("b.", abc)).toBe("B");
    expect(pick("I think option B makes more sense here", abc)).toBe("B");
    expect(pick("Let's go with B", abc)).toBe("B");
  });
  it("does not take the English article 'a' as option A", () => {
    expect(pick("a good one", abc)).toBe("none");
    expect(pick("A", abc)).toBe("A");
    expect(pick("option a", abc)).toBe("A");
  });
  it("Russian: 'вариант Б' = 2nd, spoken 'би' = B", () => {
    expect(pick("вариант Б", abc)).toBe("B");
    expect(pick("давай би", abc)).toBe("B");
    expect(pick("Вариант В", abc)).toBe("C");
  });
  it("does not take the Russian conjunction 'а' or preposition 'в' as an option", () => {
    expect(pick("а может в среду", abc)).toBe("none");
  });
  it("a letter inside a long sentence without an option word does not count", () => {
    expect(pick("we need to check plan b with the team before deciding anything", abc)).toBe("none");
  });
});

describe("matchOption: numbers and ordinals", () => {
  const opts = ["Postgres 17", "Postgres 18", "wait"];
  it("matches ordinals in Russian and English anywhere in the reply", () => {
    expect(pick("второй", opts)).toBe("Postgres 18");
    expect(pick("Я бы выбрал второй вариант, он надёжнее", opts)).toBe("Postgres 18");
    expect(pick("вторая", opts)).toBe("Postgres 18");
    expect(pick("the first one", opts)).toBe("Postgres 17");
    expect(pick("последний", opts)).toBe("wait");
  });
  it("matches digits and cardinals in short replies or after an option word", () => {
    expect(pick("2", opts)).toBe("Postgres 18");
    expect(pick("два", opts)).toBe("Postgres 18");
    expect(pick("number three", opts)).toBe("wait");
    expect(pick("we have two concerns about the rollout timeline here", opts)).toBe("none");
  });
  it("matches the option text", () => {
    expect(pick("let's just wait", opts)).toBe("wait");
  });
  it("out-of-range numbers do not match", () => {
    expect(pick("7", opts)).toBe("none");
  });
  it("two different options in one reply is ambiguous", () => {
    expect(matchOption("first or second, not sure", opts)).toEqual({ kind: "ambiguous", indexes: [0, 1] });
  });
});

describe("matchOption: yes/no", () => {
  it("Russian да/нет", () => {
    expect(pick("да", ["да", "нет"])).toBe("да");
    expect(pick("Нет, не надо", ["да", "нет"])).toBe("нет");
    expect(pick("ага, давай", ["да", "нет"])).toBe("да");
  });
  it("English synonyms map across languages", () => {
    expect(pick("yeah sure", ["yes", "no"])).toBe("yes");
    expect(pick("nope", ["yes", "no"])).toBe("no");
    expect(pick("да", ["yes", "no"])).toBe("yes");
    expect(pick("ok", ["да", "нет"])).toBe("да");
  });
  it("'не знаю' is not a no", () => {
    expect(pick("не знаю", ["да", "нет"])).toBe("none");
  });
  it("'да нет' is ambiguous", () => {
    expect(matchOption("да нет", ["да", "нет"]).kind).toBe("ambiguous");
  });
});

describe("resolveDefault", () => {
  it("accepts an option name (case-insensitive) or a 1-based number", () => {
    expect(resolveDefault("b", ["A", "B"])).toBe("B");
    expect(resolveDefault("2", ["A", "B"])).toBe("B");
    expect(resolveDefault("Z", ["A", "B"])).toBeNull();
    expect(resolveDefault("3", ["A", "B"])).toBeNull();
    expect(resolveDefault("anything", [])).toBe("anything");
    expect(resolveDefault(null, ["A"])).toBeNull();
  });
});
