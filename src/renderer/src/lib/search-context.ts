import { createContext, useContext } from 'react'

/**
 * The current search query.
 *
 * The thread and the markdown renderer live in different components, and the
 * renderer needs the query to highlight the matches where they appear.
 */
export const SearchContext = createContext('')

export function useSearchQuery(): string {
  return useContext(SearchContext)
}
