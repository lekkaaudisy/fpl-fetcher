import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { JSDOM } from 'jsdom';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Set Content Security Policy
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
  );
  next();
});

const PORT = process.env.PORT || 5000;
const loginUrl = 'https://users.premierleague.com/accounts/login/';
const email = process.env.FPL_EMAIL;
const password = process.env.FPL_PASSWORD;
const leagueId = process.env.FPL_LEAGUE_ID || '420500';

let csrfToken = '';
let cookies = '';

const customFetch = (url, options = {}) => {
  const defaultOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0',
    },
  };

  return fetch(url, { ...defaultOptions, ...options, headers: { ...defaultOptions.headers, ...options.headers } });
};

export default customFetch;

async function handleDataDomeChallenge(response) {
  const cookies = response.headers.raw()['set-cookie'];
  if (cookies) {
    const dataDomeCookie = cookies.find(cookie => cookie.startsWith('datadome='));
    if (dataDomeCookie) {
      console.log('DataDome challenge detected. Retrying with DataDome cookie...');
      const cookieValue = dataDomeCookie.split(';')[0];
      return cookieValue;
    }
  }
  return null;
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getCsrfToken() {
  try {
    console.log('Fetching CSRF token...');
    await delay(1000); // Add a 1-second delay
    let response = await customFetch(loginUrl);
    
    if (response.status === 403) {
      const dataDomeCookie = await handleDataDomeChallenge(response);
      if (dataDomeCookie) {
        response = await customFetch(loginUrl, {
          headers: {
            'Cookie': dataDomeCookie
          }
        });
      }
    }

    if (!response.ok) {
      console.log('Response status:', response.status);
      console.log('Response headers:', response.headers.raw());
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html);
    const document = dom.window.document;
    const token = document.querySelector('input[name="csrfmiddlewaretoken"]');
    
    if (!token) {
      console.log('CSRF token not found in the HTML. Here\'s the HTML content:');
      console.log(html);
      throw new Error('CSRF token not found in the HTML');
    }
    
    console.log('CSRF token fetched successfully');
    return token.value;
  } catch (error) {
    console.error('Error fetching CSRF token:', error);
    throw error;
  }
}

async function login() {
  try {
    console.log('Attempting login...');
    csrfToken = await getCsrfToken();
    await delay(1000); // Add a 1-second delay
    const params = new URLSearchParams({
      csrfmiddlewaretoken: csrfToken,
      login: email,
      password: password,
      app: 'plfpl-web',
      redirect_uri: 'https://fantasy.premierleague.com/',
    });
    let response = await customFetch(loginUrl, {
      method: 'POST',
      body: params,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `csrftoken=${csrfToken}`,
      },
      redirect: 'manual',
    });

    if (response.status === 302) {
      console.log('Login successful, following redirect...');
      const redirectUrl = response.headers.get('location');
      cookies = response.headers.raw()['set-cookie'];
      
      if (!cookies || cookies.length === 0) {
        throw new Error('No cookies received after login');
      }
      cookies = cookies.join('; ');

      // Follow the redirect
      response = await customFetch(redirectUrl, {
        headers: {
          'Cookie': cookies,
        },
      });

      if (!response.ok) {
        throw new Error(`Redirect failed with status: ${response.status}`);
      }

      console.log('Login and redirect successful');
    } else if (!response.ok) {
      console.log('Login response:', response.status, response.statusText);
      console.log('Response headers:', response.headers.raw());
      throw new Error(`Login failed with status: ${response.status}`);
    }
  } catch (error) {
    console.error('Error during login:', error);
    throw error;
  }
}

async function fetchAllGameweekData(leagueId) {
  // First, fetch the current gameweek
  const bootstrapUrl = 'https://fantasy.premierleague.com/api/bootstrap-static/';
  const bootstrapResponse = await customFetch(bootstrapUrl, {
    headers: {
      'Cookie': cookies,
    },
  });
  const bootstrapData = await bootstrapResponse.json();
  const currentGameweek = bootstrapData.events.find(event => event.is_current).id;

  // Now fetch data for each gameweek
  const allGameweekData = [];
  for (let gw = 1; gw <= currentGameweek; gw++) {
    const gwUrl = `https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/?page=1&page_standings=${gw}&phase=${gw}`;
    const gwResponse = await customFetch(gwUrl, {
      headers: {
        'Cookie': cookies,
      },
    });
    const gwData = await gwResponse.json();
    allGameweekData.push({
      gameweek: gw,
      standings: gwData.standings.results,
    });
    
    // Add a delay to avoid rate limiting
    await delay(1000);
  }

  return allGameweekData;
}

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/league', async (req, res) => {
  try {
    console.log('Fetching league data...');
    if (!cookies) {
      console.log('No cookies, attempting login...');
      await login();
    }
    
    const allGameweekData = await fetchAllGameweekData(leagueId);
    
    // Process the data into a more useful format
    const processedData = processGameweekData(allGameweekData);
    
    console.log('League data fetched and processed successfully');
    res.json(processedData);
  } catch (error) {
    console.error('An error occurred while fetching league data:', error);
    res.status(500).json({ error: 'An error occurred while fetching data', details: error.message });
  }
});

function processGameweekData(allGameweekData) {
  const managerData = {};

  allGameweekData.forEach(gwData => {
    gwData.standings.forEach(standing => {
      if (!managerData[standing.entry]) {
        managerData[standing.entry] = {
          id: standing.entry,
          name: standing.player_name,
          team_name: standing.entry_name,
          gameweeks: {},
        };
      }
      managerData[standing.entry].gameweeks[gwData.gameweek] = {
        points: standing.event_total,
        total_points: standing.total,
        rank: standing.rank,
      };
    });
  });

  return Object.values(managerData);
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});