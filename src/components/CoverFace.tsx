/**
 * The cover rectangle itself: real art when the scanner has extracted it,
 * otherwise one of the two fallback layouts from the mockups — a ruled `frame`
 * or a horizontal title `band` — drawn on the book's dominant colour.
 *
 * Each size has its own spec rather than one scaled baseline, because the large
 * hero covers in `Book.dc.html` and `Player.dc.html` deliberately use
 * proportionally smaller type than the little shelf covers do.
 */

import { Image, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font } from '@/theme/tokens';
import { fallbackVariant } from '@/lib/shelves';

export type CoverSize = 'shelf' | 'tray' | 'book' | 'player';

type Spec = {
  w: number;
  h: number;
  /** Width of the dark spine crease down the left edge. */
  spine: number;
  frame: {
    inset: { top: number; right: number; bottom: number; left: number };
    border: number;
    pad: { t: number; r: number; b: number; l: number };
    title: number;
    author: number;
  };
  band: {
    authorTop: number;
    authorLeft: number;
    authorSize: number;
    bandTop: number;
    pad: { t: number; r: number; b: number; l: number };
    title: number;
  };
};

export const COVER_SPECS: Record<Exclude<CoverSize, 'tray'>, Spec> = {
  shelf: {
    w: 86,
    h: 128,
    spine: 4,
    frame: {
      inset: { top: 7, right: 7, bottom: 7, left: 10 },
      border: 1.5,
      pad: { t: 9, r: 6, b: 7, l: 6 },
      title: 13,
      author: 9,
    },
    band: {
      authorTop: 10,
      authorLeft: 12,
      authorSize: 9,
      bandTop: 42,
      pad: { t: 8, r: 8, b: 9, l: 12 },
      title: 13,
    },
  },
  book: {
    w: 168,
    h: 248,
    spine: 6,
    frame: {
      inset: { top: 14, right: 14, bottom: 14, left: 20 },
      border: 2,
      pad: { t: 18, r: 12, b: 14, l: 12 },
      title: 22,
      author: 11,
    },
    band: {
      authorTop: 18,
      authorLeft: 22,
      authorSize: 11,
      bandTop: 92,
      pad: { t: 14, r: 16, b: 16, l: 22 },
      title: 25,
    },
  },
  player: {
    w: 192,
    h: 282,
    spine: 7,
    frame: {
      inset: { top: 16, right: 16, bottom: 16, left: 22 },
      border: 2,
      pad: { t: 20, r: 14, b: 16, l: 14 },
      title: 25,
      author: 11,
    },
    band: {
      authorTop: 20,
      authorLeft: 24,
      authorSize: 11,
      bandTop: 104,
      pad: { t: 16, r: 18, b: 18, l: 24 },
      title: 28,
    },
  },
};

export const TRAY_SPEC = { w: 56, h: 84, spine: 3, title: 9.5, pad: 7 };

/**
 * Young Serif's average advance width, as a fraction of the font size. Used only
 * to keep a long title from breaking mid-word.
 */
const CHAR_WIDTH = 0.62;

/**
 * Steps the title size down until the longest single word fits the space it has.
 * Wrapping between words is fine and intended; "Middlema / rch" is not.
 */
function fitTitleSize(title: string, available: number, max: number, min = 7.5): number {
  const longest = title
    .split(/\s+/)
    .reduce((n, word) => Math.max(n, word.length), 0);
  if (longest === 0) return max;
  const fitted = Math.floor(available / (longest * CHAR_WIDTH));
  return Math.max(min, Math.min(max, fitted));
}

export function coverDimensions(size: CoverSize, scale = 1) {
  if (size === 'tray') {
    return { width: TRAY_SPEC.w * scale, height: TRAY_SPEC.h * scale };
  }
  const spec = COVER_SPECS[size];
  return { width: spec.w * scale, height: spec.h * scale };
}

/** The dark crease plus its thin highlight, where the cover meets the spine. */
function SpineCrease({ width }: { width: number }) {
  return (
    <>
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width,
          backgroundColor: color.shade,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: width,
          top: 0,
          bottom: 0,
          width: 1,
          backgroundColor: color.sheen,
        }}
      />
    </>
  );
}

type Props = {
  book: Book;
  size: CoverSize;
  /**
   * Shrinks the whole cover proportionally. The hero sizes come from the
   * mockups' 844pt-tall canvas; on a shorter screen the Player and Book screens
   * scale their cover down rather than pushing their controls off the bottom.
   */
  scale?: number;
};

export function CoverFace({ book, size, scale = 1 }: Props) {
  /** Scales a spec measurement, never below a legible floor for text. */
  const z = (n: number) => n * scale;
  const ink = book.coverInk ?? color.paper;
  const ground = book.dominantColor ?? color.panel;

  if (size === 'tray') {
    const trayTitle = z(
      // Thumbnails may go smaller than the other covers: a long single word
      // like "Middlemarch" has very little room at 56px wide.
      fitTitleSize(book.title, TRAY_SPEC.w - 12, TRAY_SPEC.title, 5.5),
    );
    return (
      <View
        style={{
          width: z(TRAY_SPEC.w),
          height: z(TRAY_SPEC.h),
          borderRadius: 2,
          backgroundColor: ground,
          overflow: 'hidden',
          paddingTop: z(TRAY_SPEC.pad),
          paddingHorizontal: z(6),
        }}
      >
        {book.coverThumbPath ? (
          <Image
            source={{ uri: book.coverThumbPath }}
            // Sized explicitly rather than stretched to the edges: the decoder
            // needs a target size to downsample a 400px thumbnail against, and
            // without one it keeps the whole bitmap in memory.
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: z(TRAY_SPEC.w),
              height: z(TRAY_SPEC.h),
            }}
            resizeMode="cover"
          />
        ) : (
          <Text
            numberOfLines={5}
            style={{
              fontFamily: font.serif,
              fontSize: trayTitle,
              lineHeight: trayTitle * 1.1,
              color: ink,
            }}
          >
            {book.title}
          </Text>
        )}
        <SpineCrease width={z(TRAY_SPEC.spine)} />
      </View>
    );
  }

  const spec = COVER_SPECS[size];
  const variant = fallbackVariant(book.id);
  const frameTitle = z(
    fitTitleSize(
      book.title,
      spec.w - spec.frame.inset.left - spec.frame.inset.right - spec.frame.pad.l - spec.frame.pad.r,
      spec.frame.title,
    ),
  );
  const bandTitle = z(
    fitTitleSize(book.title, spec.w - spec.band.pad.l - spec.band.pad.r, spec.band.title),
  );

  return (
    <View
      style={{
        width: z(spec.w),
        height: z(spec.h),
        backgroundColor: ground,
        borderTopLeftRadius: 2,
        borderBottomLeftRadius: 2,
        borderTopRightRadius: 3,
        borderBottomRightRadius: 3,
        overflow: 'hidden',
      }}
    >
      {book.coverThumbPath ? (
        <Image
          source={{ uri: book.coverThumbPath }}
          style={{ width: z(spec.w), height: z(spec.h) }}
          resizeMode="cover"
        />
      ) : variant === 'frame' ? (
        <View
          style={{
            position: 'absolute',
            top: z(spec.frame.inset.top),
            right: z(spec.frame.inset.right),
            bottom: z(spec.frame.inset.bottom),
            left: z(spec.frame.inset.left),
            borderWidth: spec.frame.border,
            borderColor: ink,
            justifyContent: 'space-between',
            paddingTop: z(spec.frame.pad.t),
            paddingRight: z(spec.frame.pad.r),
            paddingBottom: z(spec.frame.pad.b),
            paddingLeft: z(spec.frame.pad.l),
          }}
        >
          <Text
            numberOfLines={4}
            style={{
              fontFamily: font.serif,
              fontSize: frameTitle,
              lineHeight: frameTitle * 1.08,
              color: ink,
            }}
          >
            {book.title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: font.mono,
              fontSize: z(spec.frame.author),
              letterSpacing: z(spec.frame.author) * 0.08,
              textTransform: 'uppercase',
              color: ink,
              opacity: 0.85,
            }}
          >
            {book.author}
          </Text>
        </View>
      ) : (
        <>
          <Text
            numberOfLines={1}
            style={{
              position: 'absolute',
              top: z(spec.band.authorTop),
              left: z(spec.band.authorLeft),
              right: z(6),
              fontFamily: font.mono,
              fontSize: z(spec.band.authorSize),
              letterSpacing: z(spec.band.authorSize) * 0.1,
              textTransform: 'uppercase',
              color: ink,
              opacity: 0.85,
            }}
          >
            {book.author}
          </Text>
          <View
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: z(spec.band.bandTop),
              backgroundColor: ink,
              paddingTop: z(spec.band.pad.t),
              paddingRight: z(spec.band.pad.r),
              paddingBottom: z(spec.band.pad.b),
              paddingLeft: z(spec.band.pad.l),
            }}
          >
            <Text
              numberOfLines={4}
              style={{
                fontFamily: font.serif,
                fontSize: bandTitle,
                lineHeight: bandTitle * 1.05,
                color: ground,
              }}
            >
              {book.title}
            </Text>
          </View>
        </>
      )}
      <SpineCrease width={z(spec.spine)} />
    </View>
  );
}
