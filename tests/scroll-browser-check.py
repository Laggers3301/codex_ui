"""Run against the local Vite scroll-fixture; no accounts or backend writes."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 900, "height": 650})
    page.goto("http://127.0.0.1:5188/tests/scroll-fixture.html")
    page.wait_for_function("window.scrollFixture")
    failures = []
    for thread in ["A", "B", "C", "A"]:
        page.evaluate("id => window.scrollFixture.switchThread(id)", thread)
        page.wait_for_timeout(150)
        page.evaluate("window.scrollFixture.readTop()")
        page.wait_for_timeout(150)
        anchor = page.locator(".messages").evaluate("""e => {
          const top=e.getBoundingClientRect().top;
          const m=[...e.querySelectorAll('[data-message-key]:not(.kind-tool)')].find(x=>x.getBoundingClientRect().top>=top);
          return {key:m.dataset.messageKey,offset:m.getBoundingClientRect().top-top};
        }""")
        page.evaluate("window.scrollFixture.prepend()")
        page.wait_for_timeout(850)
        result = page.locator(".messages").evaluate("""(e,a) => {
          const m=e.querySelector(`[data-message-key="${a.key}"]`);
          return {key:a.key,offset:m?m.getBoundingClientRect().top-e.getBoundingClientRect().top:null,top:e.scrollTop};
        }""", anchor)
        print(thread, "anchor", anchor, "after prepend", result)
        if result["offset"] is None or abs(result["offset"] - anchor["offset"]) > 2:
            failures.append(f"{thread}: prepend moved visible message")
        page.evaluate("window.scrollFixture.bottom()")
        page.wait_for_timeout(100)
        page.evaluate("window.scrollFixture.grow()")
        page.wait_for_timeout(1200)
        gap = page.locator(".messages").evaluate("e=>e.scrollHeight-e.clientHeight-e.scrollTop")
        print(thread, "bottom gap after growth", gap)
        if gap > 2:
            failures.append(f"{thread}: bottom lost after height changed")
    # Reaching bottom must cancel an anchor whose settling timer is still live.
    page.evaluate("window.scrollFixture.readTop(); window.scrollFixture.prepend()")
    page.wait_for_timeout(40)
    page.evaluate("window.scrollFixture.bottom()")
    page.wait_for_timeout(500)
    gaps = page.evaluate("""() => new Promise(resolve => {
      const gaps=[]; const until=performance.now()+1000;
      const sample=()=>{const e=document.querySelector('.messages');gaps.push(e.scrollHeight-e.clientHeight-e.scrollTop);
        if(performance.now()<until)requestAnimationFrame(sample);else resolve(gaps)};
      sample();
    })""")
    print("bottom while history settles, maximum gap", max(gaps))
    if max(gaps) > 2:
        failures.append("old history anchor pulled away from bottom")
    # An animation started in A cannot write to the reused B scrollport.
    page.evaluate("window.scrollFixture.readTop(); window.scrollFixture.bottom()")
    page.wait_for_timeout(50)
    page.evaluate("window.scrollFixture.switchThread('B')")
    page.wait_for_timeout(50)
    page.evaluate("window.scrollFixture.readTop()")
    page.wait_for_timeout(600)
    top = page.locator('.messages').evaluate('e=>e.scrollTop')
    print('old-thread animation after manual navigation, top',top)
    if top > 2:
        failures.append("old smooth scroll survived thread switch")
    browser.close()
    assert not failures, "; ".join(failures)
