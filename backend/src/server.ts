import app from "./app";

const port = process.env.PORT ?? 4000;

app.listen(port, () => {
  console.log(`SupportMe backend listening on http://localhost:${port}`);
});
