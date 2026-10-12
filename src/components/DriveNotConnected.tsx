/**
 * What fills the Library when the drive is not reachable: a closed card-catalogue
 * drive. Checked-out books keep playing, and anything the user asks for while
 * the drive is not connected goes on hold instead of failing.
 */

import { Text, View } from 'react-native';
import { color, font, shadow, space } from '@/theme/tokens';

function CabinetFront({ label }: { label: string }) {
  return (
    <View
      style={{
        height: 64,
        backgroundColor: color.wood,
        borderWidth: 1.5,
        borderColor: color.woodHighlight,
        borderRadius: 2,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
      }}
    >
      <View
        style={{
          backgroundColor: color.paperCard,
          borderWidth: 1,
          borderColor: '#a8916a',
          paddingHorizontal: 10,
          paddingVertical: 2,
        }}
      >
        <Text style={{ fontFamily: font.mono, fontSize: 10, color: color.inkOnLabel }}>
          {label}
        </Text>
      </View>
      {/* The brass pull. */}
      <View
        style={{
          width: 44,
          height: 8,
          borderRadius: 4,
          backgroundColor: '#c9a466',
          borderBottomWidth: 2,
          borderBottomColor: '#3a2616',
        }}
      />
    </View>
  );
}

export function DriveNotConnected({ heldCount }: { heldCount: number }) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        paddingHorizontal: 32,
      }}
    >
      <View
        accessible={false}
        style={[
          {
            width: 220,
            backgroundColor: color.woodDeep,
            borderWidth: 2,
            borderColor: color.woodEdge,
            borderRadius: 4,
            padding: space.md,
            gap: 10,
            transform: [{ rotate: '-1deg' }],
          },
          shadow(16, 0.55),
        ]}
      >
        <CabinetFront label="A – M" />
        <CabinetFront label="N – Z" />
      </View>

      <View style={{ gap: 8, alignItems: 'center' }}>
        <Text
          accessibilityRole="header"
          style={{ fontFamily: font.serif, fontSize: 24, color: color.paper }}
        >
          {`Your drive isn't connected.`}
        </Text>
        <Text
          style={{
            fontFamily: font.sans,
            fontSize: 15,
            lineHeight: 15 * 1.45,
            color: '#cbbb9e',
            textAlign: 'center',
          }}
        >
          {`Connect your drive to browse the shelves. Everything you've checked out still plays.`}
        </Text>
        {heldCount > 0 ? (
          <Text
            style={{
              fontFamily: font.mono,
              fontSize: 11,
              color: color.accent,
              textAlign: 'center',
              marginTop: space.xs,
            }}
          >
            {heldCount} {heldCount === 1 ? 'book' : 'books'} on hold, waiting for the drive
          </Text>
        ) : null}
      </View>
    </View>
  );
}
