/// Проверка ИИН (индивидуальный идентификационный номер, РК): 12 цифр.
///
/// Структура: ГГММДД (дата рождения) + цифра века/пола (1–6)
/// + 4 цифры порядкового номера + контрольная цифра.
bool isValidIin(String iin) {
  if (!RegExp(r'^\d{12}$').hasMatch(iin)) return false;

  final d = iin.split('').map(int.parse).toList();

  // Месяц 01–12, день 01–31, цифра века/пола 1–6.
  final month = d[2] * 10 + d[3];
  final day = d[4] * 10 + d[5];
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (d[6] < 1 || d[6] > 6) return false;

  // Контрольная цифра: веса 1..11, при остатке 10 — веса 3..11,1,2.
  var sum = 0;
  for (var i = 0; i < 11; i++) {
    sum += d[i] * (i + 1);
  }
  var check = sum % 11;
  if (check == 10) {
    const w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];
    sum = 0;
    for (var i = 0; i < 11; i++) {
      sum += d[i] * w2[i];
    }
    check = sum % 11;
  }
  return check != 10 && check == d[11];
}
