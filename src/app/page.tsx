import { SearchExperience } from "@/components/search-experience";

export default function Home() {
  return (
    <main>
      <SearchExperience />
      <footer>
        <p>
          Search by mood, idea, subject, or feeling. Every result is selected,
          described, and licensed by a curator.
        </p>
        <span>Art Explorer / Public-domain study</span>
      </footer>
    </main>
  );
}
