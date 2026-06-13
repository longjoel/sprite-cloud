import { auth, signIn, signOut } from "@/lib/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>Games Vault</h1>
      {!session ? (
        <form
          action={async () => {
            "use server";
            await signIn("github");
          }}
        >
          <button type="submit">Sign in with GitHub</button>
        </form>
      ) : (
        <div>
          <p>Signed in as {session.user?.name}</p>
          <form
            action={async () => {
              "use server";
              await signOut();
            }}
          >
            <button type="submit">Sign out</button>
          </form>
        </div>
      )}
    </main>
  );
}
