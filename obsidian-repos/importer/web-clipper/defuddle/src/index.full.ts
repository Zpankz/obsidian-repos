import { Defuddle } from './defuddle';
import { DefuddleOptions, DefuddleResponse } from './types';

// Export types
export type { DefuddleOptions, DefuddleResponse };

// Export Defuddle as default
export default Defuddle;

// This file exists to ensure proper type generation for the full bundle
// The actual math module switching is handled by webpack's alias configuration 