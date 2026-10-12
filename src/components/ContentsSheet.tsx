/**
 * The contents list behind the Player's "contents" button: every chapter, grouped
 * under its part heading, with the one you are in marked by a ribbon.
 */

import { useEffect, useMemo, useRef } from 'react';
import { FlatList, Modal, Pressable, Text, View } from 'react-native';
import type { Book } from '@/data/types';
import { color, font, space, TOUCH } from '@/theme/tokens';
import { clock, hoursMinutes } from '@/lib/format';
import { Ribbon } from './Ribbon';

const ROW_HEIGHT = 56;
/** Fixed, so row offsets stay computable for scrollToIndex. */
const PART_HEIGHT = 36;

type Props = {
  visible: boolean;
  book: Book;
  currentIndex: number;
  onSelect: (chapterIndex: number) => void;
  onClose: () => void;
};

export function ContentsSheet({ visible, book, currentIndex, onSelect, onClose }: Props) {
  const listRef = useRef<FlatList>(null);

  const { rows, offsets } = useMemo(() => {
    const list = book.chapters.map((chapter, index) => {
      const next = book.chapters[index + 1];
      const end = next ? next.startSec : book.durationSec;
      /** Show the part heading only when it changes. */
      const showPart = !!chapter.part && chapter.part !== book.chapters[index - 1]?.part;
      return {
        index,
        title: chapter.title,
        part: chapter.part,
        startSec: chapter.startSec,
        lengthSec: Math.max(0, end - chapter.startSec),
        showPart,
        height: ROW_HEIGHT + (showPart ? PART_HEIGHT : 0),
      };
    });
    // Running offsets, so scrollToIndex lands correctly despite the taller rows
    // that carry a part heading.
    const offsetList: number[] = new Array(list.length);
    for (let i = 0, cursor = 0; i < list.length; i += 1) {
      offsetList[i] = cursor;
      cursor += list[i].height;
    }
    return { rows: list, offsets: offsetList };
  }, [book]);

  // Open on the chapter the listener is actually in, not at chapter one.
  useEffect(() => {
    if (!visible) return;
    const target = Math.max(0, Math.min(rows.length - 1, currentIndex));
    const id = setTimeout(() => {
      listRef.current?.scrollToIndex({ index: target, viewPosition: 0.35, animated: false });
    }, 60);
    return () => clearTimeout(id);
  }, [visible, currentIndex, rows.length]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      transparent
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(10,7,5,0.6)' }}>
        <Pressable style={{ height: 90 }} onPress={onClose} accessibilityLabel="Close contents" />
        <View
          style={{
            flex: 1,
            backgroundColor: color.ground,
            borderTopLeftRadius: 14,
            borderTopRightRadius: 14,
            borderTopWidth: 1,
            borderTopColor: color.line,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: space.xl,
              paddingTop: space.lg,
              paddingBottom: space.md,
              borderBottomWidth: 1,
              borderBottomColor: color.line,
            }}
          >
            <View>
              <Text
                accessibilityRole="header"
                style={{ fontFamily: font.serif, fontSize: 22, color: color.paper }}
              >
                Contents
              </Text>
              <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                {book.chapters.length} chapters · {hoursMinutes(book.durationSec)}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close contents"
              style={({ pressed }) => ({
                minHeight: TOUCH,
                justifyContent: 'center',
                paddingHorizontal: space.md,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: font.mono, fontSize: 12, color: color.accent }}>
                close
              </Text>
            </Pressable>
          </View>

          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(row) => String(row.index)}
            getItemLayout={(_, index) => ({
              length: rows[index]?.height ?? ROW_HEIGHT,
              offset: offsets[index] ?? ROW_HEIGHT * index,
              index,
            })}
            onScrollToIndexFailed={({ index }) => {
              listRef.current?.scrollToOffset({
                offset: offsets[index] ?? 0,
                animated: false,
              });
            }}
            contentContainerStyle={{ paddingBottom: 40 }}
            renderItem={({ item }) => {
              const current = item.index === currentIndex;
              return (
                <View>
                  {item.showPart && item.part ? (
                    <Text
                      style={{
                        fontFamily: font.mono,
                        fontSize: 10,
                        letterSpacing: 1,
                        color: color.faint,
                        paddingHorizontal: space.xl,
                        // Fixed, so the precomputed row offsets stay true.
                        height: PART_HEIGHT,
                        lineHeight: PART_HEIGHT,
                      }}
                    >
                      {item.part}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={() => onSelect(item.index)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: current }}
                    accessibilityLabel={`${item.title}, ${clock(item.lengthSec)}${current ? ', playing now' : ''}`}
                    style={({ pressed }) => ({
                      height: ROW_HEIGHT,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space.md,
                      paddingHorizontal: space.xl,
                      backgroundColor: pressed ? color.panel : 'transparent',
                    })}
                  >
                    <View style={{ width: 10, alignItems: 'center' }}>
                      {current ? <Ribbon width={8} height={20} /> : null}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{
                        flex: 1,
                        fontFamily: font.sans,
                        fontSize: 15,
                        color: current ? color.accent : color.paper,
                      }}
                    >
                      {item.title}
                    </Text>
                    <Text style={{ fontFamily: font.mono, fontSize: 11, color: color.faint }}>
                      {clock(item.lengthSec)}
                    </Text>
                  </Pressable>
                </View>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}
