/** @format */

const express = require("express");
const axios = require("axios");
const WebSocket = require("ws");
const cors = require("cors");

// Constants
const PORT = 5000;
const WS_PORT = 8080;
const BINANCE_FUTURES_API_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_FUTURES_KLINE_API_URL = "https://fapi.binance.com/fapi/v1/klines";
const RSI_PERIOD = 14;
const ATR_PERIOD = 14;

// Initialize Express and WebSocket
const app = express();
app.use(cors());

// Store the previous RSI for each symbol
const previousRSIValues = {};

// Fetch all available Binance Futures coin pairs against USDT dynamically
async function fetchAllFuturesCoins() {
  try {
    const response = await axios.get(BINANCE_FUTURES_API_URL);
    const symbols = response.data.symbols;

    // Filter out all Futures pairs against USDT
    const usdtPairs = symbols
      .filter(
        (symbol) => symbol.quoteAsset === "USDT" && symbol.status === "TRADING"
      )
      .map((symbol) => symbol.symbol);

    return usdtPairs;
  } catch (error) {
    console.error("Error fetching Binance Futures coin pairs:", error.message);
    throw new Error("Could not fetch Binance Futures coin pairs");
  }
}

/**
 * Fetch Kline data from Binance Futures API.
 * @param {string} symbol - The trading pair symbol.
 * @param {string} interval - The kline interval (e.g., '1m', '15m', '1h').
 * @returns {Promise<Object[]>} - An array of kline objects.
 */
async function fetchKlineData(symbol, interval = "30m") {
  try {
    const response = await axios.get(BINANCE_FUTURES_KLINE_API_URL, {
      params: {
        symbol,
        interval,
        limit: 100, // Fetch enough data for RSI and ATR calculation
      },
    });

    return response.data.map((kline) => ({
      close: parseFloat(kline[4]),
      high: parseFloat(kline[2]),
      low: parseFloat(kline[3]),
    })); // Extracting close, high, and low prices
  } catch (error) {
    console.error(`Error fetching data for ${symbol}:`, error.message);
    throw new Error(`Could not fetch data for ${symbol}`);
  }
}

/**
 * Calculate RSI manually and determine direction.
 * @param {number[]} closingPrices - Array of closing prices.
 * @param {number} previousRSI - The previous RSI value (optional).
 * @returns {Object} - The calculated RSI value and direction.
 */
function calculateRSI(closingPrices, previousRSI = null) {
  if (closingPrices.length < RSI_PERIOD + 1) {
    throw new Error("Not enough data to calculate RSI");
  }

  let gains = 0;
  let losses = 0;

  // Calculate the initial average gain and loss
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const difference = closingPrices[i] - closingPrices[i - 1];
    if (difference > 0) {
      gains += difference;
    } else {
      losses -= difference; // Take the absolute value of the loss
    }
  }

  let averageGain = gains / RSI_PERIOD;
  let averageLoss = losses / RSI_PERIOD;

  // Calculate the RSI for the most recent closing price
  for (let i = RSI_PERIOD + 1; i < closingPrices.length; i++) {
    const difference = closingPrices[i] - closingPrices[i - 1];
    if (difference > 0) {
      averageGain = (averageGain * (RSI_PERIOD - 1) + difference) / RSI_PERIOD;
      averageLoss = (averageLoss * (RSI_PERIOD - 1)) / RSI_PERIOD;
    } else {
      averageGain = (averageGain * (RSI_PERIOD - 1)) / RSI_PERIOD;
      averageLoss = (averageLoss * (RSI_PERIOD - 1) - difference) / RSI_PERIOD;
    }
  }

  const RS = averageGain / averageLoss || 0;
  const RSI = 100 - 100 / (1 + RS);

  // Determine RSI direction
  const direction = getRSIDirection(RSI, previousRSI);

  return {
    rsi: parseFloat(RSI.toFixed(2)),
    direction,
  };
}

/**
 * Determine the RSI direction.
 * @param {number} currentRSI - The current RSI value.
 * @param {number|null} previousRSI - The previous RSI value.
 * @returns {string} - The RSI direction (e.g., "Neutral to Overbought").
 */
function getRSIDirection(currentRSI, previousRSI) {
  if (previousRSI === null) {
    return "Unknown"; // If no previous RSI is available
  }

  const currentCategory = categorizeRSI(currentRSI);
  const previousCategory = categorizeRSI(previousRSI);

  if (currentCategory === previousCategory) {
    return "No Change";
  }

  return `${previousCategory} to ${currentCategory}`;
}

/**
 * Categorize RSI value into "Oversold", "Neutral", or "Overbought".
 * @param {number} rsi - The RSI value.
 * @returns {string} - The RSI category.
 */
function categorizeRSI(rsi) {
  if (rsi >= 70) {
    return "Overbought";
  } else if (rsi <= 30) {
    return "Oversold";
  } else {
    return "Neutral";
  }
}

/**
 * Calculate the Average True Range (ATR).
 * @param {Object[]} klineData - Array of kline data objects with high, low, and close prices.
 * @returns {number} - The calculated ATR value.
 */
function calculateATR(klineData) {
  if (klineData.length < ATR_PERIOD + 1) {
    throw new Error("Not enough data to calculate ATR");
  }

  const trueRanges = [];

  // Calculate True Range for each period
  for (let i = 1; i < klineData.length; i++) {
    const high = klineData[i].high;
    const low = klineData[i].low;
    const previousClose = klineData[i - 1].close;

    const trueRange = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );

    trueRanges.push(trueRange);
  }

  // Calculate the initial ATR
  let atr = trueRanges.slice(0, ATR_PERIOD).reduce((sum, tr) => sum + tr, 0) / ATR_PERIOD;

  // Smoothing the ATR calculation for the remaining data
  for (let i = ATR_PERIOD; i < trueRanges.length; i++) {
    atr = (atr * (ATR_PERIOD - 1) + trueRanges[i]) / ATR_PERIOD;
  }

  return parseFloat(atr.toFixed(2));
}

/**
 * Fetch RSI and ATR data for all Binance Futures coins.
 * @param {string} interval - The timeframe for calculations.
 * @returns {Promise<Object[]>} - Array of data objects with RSI, ATR, and direction.
 */
async function getAllIndicators(interval = "30m") {
  const coins = await fetchAllFuturesCoins();

  const indicatorData = await Promise.all(
    coins.map(async (symbol) => {
      try {
        const klineData = await fetchKlineData(symbol, interval);
        const closingPrices = klineData.map((data) => data.close);
        const previousRSI = previousRSIValues[symbol] || null;
        const { rsi, direction } = calculateRSI(closingPrices, previousRSI);

        // Update the stored previous RSI for the symbol
        previousRSIValues[symbol] = rsi;

        const atr = calculateATR(klineData);
        return { symbol, rsi, atr, direction, interval };
      } catch (error) {
        return { symbol, error: error.message };
      }
    })
  );

  return indicatorData;
}

// REST API Endpoint
app.get("/api/indicators", async (req, res) => {
  try {
    const indicatorData = await getAllIndicators();
    res.json(indicatorData);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch indicator data" });
  }
});

// WebSocket Server
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");

  // Store the current timeframe for each client
  let currentTimeframe = "30m";

  // Function to send indicator updates based on the current timeframe
  const sendIndicatorUpdates = async () => {
    while (ws.readyState === WebSocket.OPEN) {
      try {
        const indicatorData = await getAllIndicators(currentTimeframe);
        ws.send(JSON.stringify(indicatorData));
      } catch (error) {
        ws.send(JSON.stringify({ error: "Failed to fetch indicator data" }));
      }
      await new Promise((resolve) => setTimeout(resolve, 8000)); // Update every 8 seconds
    }
  };

  sendIndicatorUpdates();

  // Handle messages from the client
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    // If the client sends a new timeframe, update it
    if (data.timeframe) {
      currentTimeframe = data.timeframe;
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
  });
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
