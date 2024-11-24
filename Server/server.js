const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const dotenv = require('dotenv');
const cors = require('cors');

// Configure dotenv for environment variables
dotenv.config();

const app = express();
const port = 5000;

// Binance API credentials
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET;

if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
  console.error("Binance API credentials are missing. Ensure they are in your .env file.");
  process.exit(1);
}

// Binance Base URL
const BASE_URL = 'https://fapi.binance.com';

// Middleware
app.use(express.json());
app.use(cors());

// Helper: Sign Request
const signRequest = (params) => {
  const queryString = new URLSearchParams(params).toString();
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
};

// Function: Get Symbol Precision (for quantity)
const getSymbolPrecision = async (symbol) => {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/exchangeInfo`, {
      params: { symbol },
    });
    const filters = response.data.symbols[0].filters;
    const lotSizeFilter = filters.find(f => f.filterType === 'LOT_SIZE');
    return lotSizeFilter ? parseInt(lotSizeFilter.stepSize.split('1')[1].length) : 0;
  } catch (error) {
    console.error("Error fetching symbol precision:", error.response?.data || error.message);
    return 0;
  }
};

// Function: Set Leverage
const setLeverage = async (symbol, leverage) => {
  const timestamp = Date.now();
  const params = {
    symbol,
    leverage,
    timestamp,
  };
  params.signature = signRequest(params);

  try {
    const response = await axios.post(`${BASE_URL}/fapi/v1/leverage`, null, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      params,
    });
    console.log(`Leverage set to ${leverage}x for ${symbol}.`);
  } catch (error) {
    console.error("Error setting leverage:", error.response?.data || error.message);
  }
};

// Function: Get Current Market Price
const getCurrentPrice = async (symbol) => {
  try {
    const response = await axios.get(`${BASE_URL}/fapi/v1/ticker/price`, {
      params: { symbol },
    });
    return parseFloat(response.data.price); // Return the current price as a float
  } catch (error) {
    console.error("Error fetching market price:", error.response?.data || error.message);
    return null;
  }
};

// Function: Place Market Order
const placeMarketOrder = async (symbol, side, usdtAmount) => {
  const timestamp = Date.now();

  // Step 1: Get Current Price
  const marketPrice = await getCurrentPrice(symbol);
  if (!marketPrice) {
    console.error("Failed to fetch market price. Order aborted.");
    return null;
  }

  // Step 2: Calculate Quantity in Base Asset
  const quantity = (usdtAmount / marketPrice).toFixed(4); // Initial quantity calculation

  // Step 3: Get Precision and Round Quantity
  const precision = await getSymbolPrecision(symbol);
  const roundedQuantity = parseFloat(quantity).toFixed(precision); // Round the quantity to the correct precision

  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity: roundedQuantity,
    timestamp,
  };
  params.signature = signRequest(params);

  try {
    console.log(`Placing ${side} market order for $${usdtAmount} (${roundedQuantity} ${symbol.split('USDT')[0]})...`);
    const response = await axios.post(`${BASE_URL}/fapi/v1/order`, null, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      params,
    });

    console.log("Market order placed successfully:", response.data);

    return { ...response.data, marketPrice, roundedQuantity }; // Return order details and price
  } catch (error) {
    console.error("Error placing market order:", error.response?.data || error.message);
    return null;
  }
};

// Function: Set Take Profit Order
const setTakeProfit = async (symbol, side, quantity, entryPrice) => {
  const takeProfitPrice = side === 'BUY' ? entryPrice + 1 : entryPrice - 1; // Take profit at $1 profit
  const timestamp = Date.now();
  const params = {
    symbol,
    side: side === 'BUY' ? 'SELL' : 'BUY', // Opposite side for take profit
    type: 'LIMIT',
    quantity,
    price: takeProfitPrice.toFixed(2),
    timeInForce: 'GTC', // Good-Till-Cancelled
    timestamp,
  };
  params.signature = signRequest(params);

  try {
    console.log(`Setting take profit order at $${takeProfitPrice} for ${symbol}...`);
    const response = await axios.post(`${BASE_URL}/fapi/v1/order`, null, {
      headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
      params,
    });

    console.log("Take profit order placed successfully:", response.data);
  } catch (error) {
    console.error("Error placing take profit order:", error.response?.data || error.message);
  }
};

// Function: Place Order and Set Take Profit
const executeTrade = async () => {
  const symbol = 'OMUSDT'; // Trading pair
  const side = 'SELL'; // Buy or Sell
  const usdtAmount = 500; // Amount in USDT to trade
  const leverage = 10; // Set leverage

  // Step 1: Set Leverage
  await setLeverage(symbol, leverage);

  // Step 2: Place Market Order
  const marketOrder = await placeMarketOrder(symbol, side, usdtAmount);

  if (marketOrder) {
    const entryPrice = parseFloat(marketOrder.marketPrice);

    if (!entryPrice) {
      console.error("Error: Could not retrieve entry price from market order response.");
      return;
    }

    console.log(`Market order filled at $${entryPrice}. Setting take profit...`);

    // Step 3: Set Take Profit Order Immediately
    await setTakeProfit(symbol, side, marketOrder.roundedQuantity, entryPrice);
  } else {
    console.error("Market order failed. No take profit order will be set.");
  }
};

// Test the Trade Execution
executeTrade();

// Start Server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
