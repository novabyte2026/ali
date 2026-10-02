import { HomeView } from '@/components/home/HomeView';

/**
 * Home page.
 *
 * A server component that renders the client view. The content is static
 * enough to be prerendered; the source-card availability comes from the
 * provider context the shell already fetched, so the page does not block on
 * its own request.
 */
export default function HomePage() {
  return <HomeView />;
}
