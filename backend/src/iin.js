// Проверка ИИН (РК): 12 цифр, дата рождения, цифра века/пола и контрольная цифра.
export function isValidIin(iin) {
  if (typeof iin !== 'string' || !/^\d{12}$/.test(iin)) return false;
  const d = iin.split('').map(Number);

  const month = d[2] * 10 + d[3];
  const day = d[4] * 10 + d[5];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (d[6] < 1 || d[6] > 6) return false;

  let sum = 0;
  for (let i = 0; i < 11; i++) sum += d[i] * (i + 1);
  let check = sum % 11;
  if (check === 10) {
    const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    sum = 0;
    for (let i = 0; i < 11; i++) sum += d[i] * w2[i];
    check = sum % 11;
  }
  return check !== 10 && check === d[11];
}

/** ИИН для журнала: первые 6 цифр (дата рождения) и звёздочки. */
export function maskIin(iin) {
  return typeof iin === 'string' && iin.length === 12
    ? `${iin.slice(0, 6)}******`
    : '??????******';
}
