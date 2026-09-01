import {
  applyOtpBackspace,
  applyOtpInput,
  enrollCodeComplete,
  joinEnrollCode,
  normalizeEnrollCode,
  splitEnrollCode,
} from "./enrollOtp";

const empty = splitEnrollCode("");

const cases: Array<[string, boolean, () => boolean]> = [
  ["normalize strips dash and spaces", true, () => normalizeEnrollCode("ab cd-2345") === "ABCD2345"],
  ["normalize drops ambiguous 0/1/I/O", true, () => normalizeEnrollCode("AB01IO23") === "AB23"],
  ["split is 8 boxes", true, () => splitEnrollCode("ABCD-2345").join("") === "ABCD2345" && splitEnrollCode("ABCD-2345").length === 8],
  ["paste into first box fills all", true, () => {
    const { boxes, focus } = applyOtpInput(empty, 0, "abcd-2345");
    return joinEnrollCode(boxes) === "ABCD2345" && focus === 7 && enrollCodeComplete(boxes);
  }],
  ["paste without dash still fills", true, () => joinEnrollCode(applyOtpInput(empty, 0, "ABCD2345").boxes) === "ABCD2345"],
  ["typing one char advances", true, () => {
    const { boxes, focus } = applyOtpInput(empty, 0, "A");
    return boxes[0] === "A" && focus === 1 && !enrollCodeComplete(boxes);
  }],
  ["backspace on empty moves back and clears", true, () => {
    const filled = splitEnrollCode("AB");
    const { boxes, focus } = applyOtpBackspace(filled, 2);
    return boxes[1] === "" && focus === 1;
  }],
  ["backspace on filled clears current", true, () => {
    const filled = splitEnrollCode("AB");
    const { boxes, focus } = applyOtpBackspace(filled, 1);
    return boxes[1] === "" && boxes[0] === "A" && focus === 1;
  }],
];

let failed = 0;
for (const [name, want, run] of cases) {
  const got = run();
  if (got !== want) {
    failed += 1;
    console.error(`FAIL ${name}: got ${got}, want ${want}`);
  }
}
if (failed) throw new Error(`${failed} enrollOtp case(s) failed`);
console.log(`ok ${cases.length} enrollOtp cases`);
