/** The production lock must always execute its complete mandatory set. */
export function hasExpectedCheckCount(actual, expected = 61) {
  return actual === expected;
}
