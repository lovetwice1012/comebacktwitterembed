// Match the existing receipt-email shape with one bounded, linear pass.
export function isPaymentEmail(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  let separator = -1;
  let lastDot = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (/\s/.test(character)) return false;
    if (character === "@") {
      if (separator !== -1) return false;
      separator = index;
    } else if (character === ".") {
      lastDot = index;
    }
  }
  return separator > 0 && lastDot > separator + 1 && lastDot < value.length - 1;
}
