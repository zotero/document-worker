// Header bit flags for text runs
const HEADER_LAST_IS_SOFT_HYPHEN = 1 << 0;
const HEADER_AXIS_DIR_SHIFT = 1;
const HEADER_DIR_RTL = 1 << 3;

// Epsilon for floating point comparisons
const EPS = 1e-3;

// Check if axis direction is vertical (1 or 3)
const isVertical = axisDir => axisDir === 1 || axisDir === 3;

export {
	HEADER_LAST_IS_SOFT_HYPHEN,
	HEADER_AXIS_DIR_SHIFT,
	HEADER_DIR_RTL,
	EPS,
	isVertical,
};