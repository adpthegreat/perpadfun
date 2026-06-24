import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/home")({
  component: () => <Navigate to="/" />,
  head: () => ({
    meta: [
      { title: "perpspad" },
      { name: "description", content: "perpspad" },
    ],
  }),
});
