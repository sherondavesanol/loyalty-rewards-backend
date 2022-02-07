import "@babel/polyfill";
import dotenv from "dotenv";
import "isomorphic-fetch";
import createShopifyAuth, { verifyRequest } from "@shopify/koa-shopify-auth";
import Shopify, { ApiVersion, DataType } from "@shopify/shopify-api";
import Koa from "koa";
import next from "next";
import Router from "koa-router";
import bcrypt from "bcrypt";

dotenv.config();
const port = parseInt(process.env.PORT, 10) || 8081;
const dev = process.env.NODE_ENV !== "production";
const app = next({
  dev,
});
const handle = app.getRequestHandler();

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https:\/\/|\/$/g, ""),
  API_VERSION: ApiVersion.October20,
  IS_EMBEDDED_APP: true,
  // This should be replaced with your preferred storage strategy
  SESSION_STORAGE: new Shopify.Session.MemorySessionStorage(),
});

// Storing the currently active shops in memory will force them to re-login when your server restarts. You should
// persist this object in your app.
const ACTIVE_SHOPIFY_SHOPS = {};

app.prepare().then(async () => {
  const server = new Koa();
  const router = new Router();
  server.keys = [Shopify.Context.API_SECRET_KEY];
  server.use(
    createShopifyAuth({
      async afterAuth(ctx) {
        // Access token and shop available in ctx.state.shopify
        const { shop, accessToken, scope } = ctx.state.shopify;
        const host = ctx.query.host;
        ACTIVE_SHOPIFY_SHOPS[shop] = scope;

        const response = await Shopify.Webhooks.Registry.register({
          shop,
          accessToken,
          path: "/webhooks",
          topic: "APP_UNINSTALLED",
          webhookHandler: async (topic, shop, body) =>
            delete ACTIVE_SHOPIFY_SHOPS[shop],
        });

        if (!response.success) {
          console.log(
            `Failed to register APP_UNINSTALLED webhook: ${response.result}`
          );
        }

        // Redirect to app with shop parameter upon auth
        ctx.redirect(`/?shop=${shop}&host=${host}`);
      },
    })
  );

  const handleRequest = async (ctx) => {
    await handle(ctx.req, ctx.res);
    ctx.respond = false;
    ctx.res.statusCode = 200;
  };

  router.post("/webhooks", async (ctx) => {
    try {
      await Shopify.Webhooks.Registry.process(ctx.req, ctx.res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (error) {
      console.log(`Failed to process webhook: ${error}`);
    }
  });

  router.post(
    "/graphql",
    verifyRequest({ returnHeader: true }),
    async (ctx, next) => {
      await Shopify.Utils.graphqlProxy(ctx.req, ctx.res);
    }
  );

  /* retrieves the list of existing price rules, called when finding the corresponding price rule to generate a discount code */
  router.get("/pricerule", async (ctx) => {
    try {
      const session = await Shopify.Utils.loadCurrentSession(ctx.req, ctx.res);
      const client = new Shopify.Clients.Rest(session.shop, session.accessToken);
      const data = await client.get({
        path: 'price_rules'
      });

      ctx.status = 200;
      ctx.body = data;
    } catch (error) {
      console.log(error);
    }
  })

  /* creates a new price rule, called everytime the client creates a new reward option */
  router.post("/pricerule/new", async (ctx) => {
    try {
      const session = await Shopify.Utils.loadCurrentSession(ctx.req, ctx.res);
      const client = new Shopify.Clients.Rest(session.shop, session.accessToken);
      const data = await client.post({
        path: 'price_rules',
        data: {
          "price_rule": {
            "title": "REWARDNAME", /*  Reward title, assigned to each redeem reward button */
            "target_type": "line_item", /* line_item for item discount, delivery_line for line discount */
            "target_selection": "all",
            "allocation_method": "across",
            "value_type": "percentage", /* fixed_amount for flat discount, percentage for percentage discount */
            "value": "-10.0", /* value of discount */
            "customer_selection": "all",
            "starts_at": "2022-02-19T17:59:10Z" /* replace to get current date every new create instance */
          }},
        type: DataType.JSON
      });

      ctx.status = 200;
      ctx.body = data;
    } catch (error) {
      console.log(error);
    }
  });

  /* callback function generating a new code, called everytime the /discount/new endpoint is accessed */
  async function generateCode() {
    const date = new Date().toLocaleDateString();
    const salt = await bcrypt.genSalt(6);
    const hashed = await bcrypt.hash(date, salt);
    const tempCode = hashed.substring(0, 12);
    const code = tempCode.replace(/[^A-Za-z0-9]/g, 'N').toUpperCase();

    return code;
  }

  /* creates a new discount code, called everytime the customer redeems a reward */
  router.post("/discount/new", async (ctx) => {

    try {
      const session = await Shopify.Utils.loadCurrentSession(ctx.req, ctx.res);
      const client = new Shopify.Clients.Rest(session.shop, session.accessToken);

      const pricerules = await client.get({
        path: 'price_rules'
      });

      /* "REWARDNAME" must be dynamically replaced by the corresponding reward name assigned to each redeem reward button (passed as argument) */
      const pricerule = pricerules.body.price_rules.find(rule => rule.title === "REWARDNAME");

      const data = await client.post({
        path: `price_rules/${pricerule.id}/discount_codes`,
        data: {
          "discount_code": {
            "code": await generateCode() /* DYNAMIC VALUE - generated by generateCode callback function */
          }},
        type: DataType.JSON
      });

      ctx.status = 200;
      /* name of the code returned within the ctx.body must be rendered in the app extension to be seen by the customer */
      ctx.body = data;
    } catch (error) {
      console.log(error);
    }
  });

  router.get("(/_next/static/.*)", handleRequest); // Static content is clear
  router.get("/_next/webpack-hmr", handleRequest); // Webpack content is clear
  router.get("(.*)", async (ctx) => {
    const shop = ctx.query.shop;

    // This shop hasn't been seen yet, go through OAuth to create a session
    if (ACTIVE_SHOPIFY_SHOPS[shop] === undefined) {
      ctx.redirect(`/auth?shop=${shop}`);
    } else {
      await handleRequest(ctx);
    }
  });

  server.use(router.allowedMethods());
  server.use(router.routes());
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
