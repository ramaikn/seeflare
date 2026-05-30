// Using native fetch (Node >=18)
const WORKER_URL = 'https://counterscale.ramaiknx.workers.dev';

async function testStats(siteId, interval = 'today', timezone = 'UTC') {
  const url = `${WORKER_URL}/resources/stats?site=${siteId}&interval=${interval}&timezone=${timezone}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Error:', res.status, res.statusText);
    return;
  }
  const data = await res.json();
  console.log('Stats response:', JSON.stringify(data, null, 2));
}

testStats('resonansipers');
