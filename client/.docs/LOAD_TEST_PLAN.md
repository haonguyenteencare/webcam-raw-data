# Load Testing Plan

## Objective
Verify that the backend server can handle concurrent uploads of raw video frames and audio samples from multiple students (10 -> 20 -> 40).

## Methodology

### Phase 1: Local Simulation (10 Machines)
- Use a script to spawn 10 headless Chrome instances using Puppeteer.
- Each instance loads a Google Meet page (or a mock page that triggers `getUserMedia`).
- Monitor server resource usage (CPU, RAM, Disk I/O).

### Phase 2: Distributed Simulation (20-40 Machines)
- Use a load testing tool like **K6** or **JMeter** to simulate the API requests if actual browser instances are too heavy for a single test runner.
- Alternatively, use a grid of test runners (e.g., Selenium Grid or Playwright on multiple VMs).

## Metrics to Track
- **Server Response Time**: P50, P95, P99 for `/api/capture/batch`.
- **Error Rate**: Percentage of failed uploads.
- **Throughput**: MB/s received by the server.
- **Disk Usage**: GB/hour for 40 concurrent sessions.

## Stress Test Script (Example)

```javascript
// load-test.js (using Puppeteer)
const puppeteer = require('puppeteer');

async function runStudent(id) {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://meet.google.com/test-meeting');
  // Inject extension logic or use a pre-installed extension
  console.log(`Student ${id} active`);
}

for (let i = 0; i < 40; i++) {
  runStudent(i);
}
```

## Scaling Bottlenecks
- **JSON Parsing**: Large payloads can block the Node.js event loop.
- **Disk Write Speed**: Writing thousands of small files can be slow. (Solution: Use a buffer or append-only log).
- **Memory Limit**: Express default JSON limit might need tuning (currently 100MB).
