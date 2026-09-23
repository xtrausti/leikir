import fs from "node:fs/promises";
import { chromium } from "playwright";

const config = JSON.parse(await fs.readFile(new URL("../watch-config.json", import.meta.url), "utf8"));
const indexPath = new URL("../index.html", import.meta.url);
const DAY = 24 * 60 * 60 * 1000;
const monthShort = ["jan", "feb", "mar", "apr", "maí", "jún", "júl", "ágú", "sep", "okt", "nóv", "des"];
const monthLong = ["janúar", "febrúar", "mars", "apríl", "maí", "júní", "júlí", "ágúst", "september", "október", "nóvember", "desember"];
const weekdays = ["sun", "mán", "þri", "mið", "fim", "fös", "lau"];
const capitalVenues = /smár|laugardal|kennara|hellir|hlíðarenda|urriðaholt|ásvell|kórinn|digranes|varmá|álftanes|grafarvog|dalhús|fjöln|dhl|origo|kr-heimili/i;

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function parseDate(value) {
  const match = value.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!match) throw new Error("Óþekkt dagsetning frá KKÍ: " + value);
  const parts = match.slice(1).map(Number);
  return new Date(Date.UTC(parts[2], parts[1] - 1, parts[0], parts[3], parts[4]));
}

function cleanOpponent(raw, suffixPattern) {
  return raw.replace(/^(gegn|@)\s*/i, "").replace(new RegExp(suffixPattern, "i"), "").trim();
}

async function scrape(browser, source) {
  const page = await browser.newPage({ locale: "is-IS", userAgent: "Mozilla/5.0 GitHub-Actions KKI leikjavakt" });
  try {
    await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("tr")].some(row =>
        /^\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}/.test(row.querySelector("td")?.innerText.trim() || "")
      ), null, { timeout: 60000 });
    for (const select of await page.locator("select").all()) {
      if (await select.locator('option[value="all"]').count()) await select.selectOption("all");
    }
    await page.waitForTimeout(750);
    const rows = await page.locator("tr").evaluateAll(elements => elements.map(row => {
      const cells = [...row.querySelectorAll(":scope > td")].map(cell => cell.innerText.trim());
      const firstLink = row.querySelector("td:first-child a");
      return {
        cells,
        gameId: firstLink?.getAttribute("game_id") || new URL(firstLink?.href || "https://kki.is").searchParams.get("game_id")
      };
    }).filter(row => row.cells.length >= 4 && /^\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}$/.test(row.cells[0])));
    if (!rows.length) throw new Error("Engir leikir fundust fyrir " + source.team);
    return rows.map(({ cells, gameId }) => {
      const dateText = cells[0];
      let rawOpponent;
      let result;
      let venue;
      let home;
      if (source.mode === "pair") {
        const homeTeam = cells[1];
        result = cells[2] || "-";
        const awayTeam = cells[3];
        venue = cells[4];
        home = homeTeam.trim().toLocaleLowerCase("is") === source.kkiTeam.trim().toLocaleLowerCase("is");
        rawOpponent = home ? awayTeam : homeTeam;
      } else {
        rawOpponent = cells[1];
        result = cells[2] || "-";
        venue = cells[3];
        home = /^gegn\s/i.test(rawOpponent);
      }
      return {
        gameId,
        key: source.key,
        team: source.team,
        date: parseDate(dateText),
        time: dateText.slice(-5),
        opponent: cleanOpponent(rawOpponent, source.suffixPattern),
        home,
        result,
        venue
      };
    });
  } finally {
    await page.close();
  }
}

function rangeText(start, end) {
  if (start.getUTCFullYear() === end.getUTCFullYear()) {
    return start.getUTCDate() + ". " + monthLong[start.getUTCMonth()] + "–" + end.getUTCDate() + ". " + monthLong[end.getUTCMonth()] + " " + end.getUTCFullYear();
  }
  return start.getUTCDate() + ". " + monthLong[start.getUTCMonth()] + " " + start.getUTCFullYear() + "–" + end.getUTCDate() + ". " + monthLong[end.getUTCMonth()] + " " + end.getUTCFullYear();
}

function article(game) {
  const day = game.date.getUTCDate();
  const month = monthShort[game.date.getUTCMonth()];
  const weekday = weekdays[game.date.getUTCDay()];
  const match = game.home ? game.team + " — " + game.opponent : game.opponent + " — " + game.team;
  const travel = !game.home && !capitalVenues.test(game.venue);
  const result = game.result && game.result !== "-" ? " · úrslit " + esc(game.result) : "";
  const teamAttribute = game.key === "augnablik" ? "" : ' data-team="' + esc(game.key) + '"';
  return '<article class="game' + (travel ? " travel" : "") + '"' + teamAttribute + '><div class="date"><strong>' + day + '</strong><span>' + month + " · " + weekday + '</span></div><div><div class="who"><span class="dot"></span>' + esc(game.team) + '</div><p class="match">' + esc(match) + '</p><p class="details">' + esc(game.time) + " · " + (game.home ? "heima" : "úti") + " · " + esc(game.venue) + result + "</p>" + (travel ? '<span class="travel-badge">📍 Utan höfuðborgarsvæðis</span>' : "") + "</div></article>";
}

const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const end = new Date(today.getTime() + 42 * DAY);
const browser = await chromium.launch({ headless: true });
let games;
try {
  games = (await Promise.all(config.sources.map(source => scrape(browser, source)))).flat();
} finally {
  await browser.close();
}
games = games.filter(game => game.date >= today && game.date < end).sort((a, b) => a.date - b.date || a.team.localeCompare(b.team, "is"));
if (!games.length) throw new Error("Engir leikir fundust á næstu sex vikum; síðunni var ekki breytt.");

const checked = new Date();
const checkedText = checked.getUTCDate() + ". " + monthLong[checked.getUTCMonth()] + " " + checked.getUTCFullYear() + " kl. " + String(checked.getUTCHours()).padStart(2, "0") + ":" + String(checked.getUTCMinutes()).padStart(2, "0");
const next = games[0];
const nextWeekday = weekdays[next.date.getUTCDay()];
const nextSection = '<section class="next-game" aria-labelledby="next-heading"><div class="ball" aria-hidden="true">🏀</div><div><p class="next-label" id="next-heading">Næsti leikur</p><p class="next-title">' + esc(next.team) + " gegn " + esc(next.opponent) + '</p><p class="next-meta">' + nextWeekday[0].toUpperCase() + nextWeekday.slice(1) + ". " + next.date.getUTCDate() + ". " + monthShort[next.date.getUTCMonth()] + ". kl. " + esc(next.time) + " · " + esc(next.venue) + "</p></div></section>";
const schedule = '<section class="schedule" aria-label="Leikjadagskrá">\n' + games.map(article).join("\n") + "\n</section>";

let html = await fs.readFile(indexPath, "utf8");
html = html
  .replace(/<p class="updated">[\s\S]*?<\/p>/, '<p class="updated">' + rangeText(today, end) + "</p>")
  .replace(/<p class="checked">[\s\S]*?<\/p>/, '<p class="checked">↻ KKÍ síðast skoðað: <time datetime="' + checked.toISOString() + '">' + checkedText + "</time></p>")
  .replace(/<section class="next-game"[\s\S]*?<\/section>/, nextSection)
  .replace(/<section class="schedule"[\s\S]*?<\/section>/, schedule);
await fs.writeFile(indexPath, html);
console.log("Uppfærði " + config.pageTitle + ": " + games.length + " leikir.");
