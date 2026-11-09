function getTodayInKualaLumpur(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + '-' + values.month + '-' + values.day;
}

function getFirstDayOfMonth(date) {
  return date.slice(0, 7) + '-01';
}

module.exports = { getTodayInKualaLumpur, getFirstDayOfMonth };
